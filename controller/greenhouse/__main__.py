"""Command line: `greenhouse <command>` (or `python -m greenhouse <command>`).

  init-db [--sim]          create tables, load the registry, (--sim: seed simulator calibrations)
  create-user EMAIL        add or reset an account (prompts for the password)
  api | sensors | control | sync | sim-nodes    run one service (systemd runs each separately)
  dev                      everything in one process against the simulator — no broker, no hardware
  schema-sql               print the MySQL DDL
  hw …                     bench and commissioning checks (see greenhouse/hwcheck.py)
"""
from __future__ import annotations

import argparse
import getpass
import logging
import os
import signal
import sys
import threading

from .config import Settings, get_settings
from .db import Database
from .registry import load_registry
from .seed import create_user, sync_registry
from .timeutil import iso, set_local_tz, utcnow

log = logging.getLogger("greenhouse")


def _setup(settings: Settings):
    logging.basicConfig(level=os.environ.get("GH_LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    reg = load_registry(settings.registry_path)
    set_local_tz(reg.timezone)
    db = Database(settings.database_url)
    db.create_all()
    sync_registry(db, reg)
    return reg, db


def _seed_sim_calibrations(db: Database, reg) -> int:
    from sqlalchemy import select

    from .hal.sim import sim_calibrations
    from .models import Calibration, Sensor
    n = 0
    with db.session() as s:
        have = {c.sensor_id for c in s.execute(select(Calibration)).scalars().all()}
        for sid, consts in sim_calibrations(reg).items():
            if sid not in have:
                s.add(Calibration(sensor_id=sid, constants=consts, performed_by="simulator", note="simulator defaults"))
                row = s.get(Sensor, sid)
                if row:
                    row.calibrated_at = utcnow()
                n += 1
    return n


def _wait_forever(stoppers) -> None:
    ev = threading.Event()

    def _stop(*_):
        for s in stoppers:
            try:
                s()
            except Exception:
                pass
        ev.set()
    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)
    ev.wait()


def _bus(settings, name, will=None):
    from .bus import make_bus
    b = make_bus(settings, f"greenhouse-{name}-{os.getpid()}", will=will)
    b.start()
    return b


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="greenhouse", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    i = sub.add_parser("init-db"); i.add_argument("--sim", action="store_true")
    u = sub.add_parser("create-user"); u.add_argument("email"); u.add_argument("--name", default=None)
    u.add_argument("--role", default="admin", choices=["admin", "viewer"]); u.add_argument("--password", default=None)
    a = sub.add_parser("api"); a.add_argument("--host", default="0.0.0.0"); a.add_argument("--port", type=int, default=8000)
    sub.add_parser("sensors"); sub.add_parser("control"); sub.add_parser("sync")
    sn = sub.add_parser("sim-nodes"); sn.add_argument("--interval", type=float, default=30.0)
    d = sub.add_parser("dev"); d.add_argument("--host", default="0.0.0.0"); d.add_argument("--port", type=int, default=8000)
    d.add_argument("--interval", type=float, default=10.0, help="simulated node publish interval (s)")
    d.add_argument("--cycle", type=float, default=10.0, help="control cycle (s); 30 in production")
    sub.add_parser("schema-sql")
    from . import hwcheck
    hwcheck.add_parser(sub)
    args = p.parse_args(argv)
    settings = get_settings()

    if args.cmd == "schema-sql":
        from sqlalchemy import create_mock_engine
        from sqlalchemy.schema import CreateIndex, CreateTable

        from .models import Base
        eng = create_mock_engine("mysql+pymysql://", lambda *a, **k: None)
        print("-- MySQL 8 schema for the greenhouse controller (reference copy).\n"
              "-- `greenhouse init-db` creates the same tables; this file is for review and the manuscript.\n")
        for t in Base.metadata.sorted_tables:
            print(str(CreateTable(t).compile(eng)).strip() + ";")
            for ix in sorted(t.indexes, key=lambda i: i.name or ""):
                print(str(CreateIndex(ix).compile(eng)).strip() + ";")
            print()
        return

    reg, db = _setup(settings)

    if args.cmd == "hw":
        hwcheck.run(args, settings, reg, db)
        return

    if args.cmd == "init-db":
        n = _seed_sim_calibrations(db, reg) if args.sim else 0
        print(f"database ready ({settings.database_url.split('@')[-1]}); {len(reg.sensors)} sensors, "
              f"{len(reg.actuators)} actuators" + (f"; {n} simulator calibrations" if args.sim else ""))
        return

    if args.cmd == "create-user":
        pw = args.password
        while not pw:
            pw = getpass.getpass("Password (min 8 chars, nothing shows while typing): ")
            if len(pw) < 8:
                print(f"  that was {len(pw)} characters; it needs at least 8 — try again")
                pw = ""
            elif getpass.getpass("Type it again: ") != pw:
                print("  the two passwords did not match — try again")
                pw = ""
        u = create_user(db, args.email, pw, args.name or args.email.split("@")[0], args.role)
        print(f"saved {u.email} ({u.role})")
        return

    from .bus import Topics
    topics = Topics(reg.greenhouse_id)

    if args.cmd == "api":
        import uvicorn

        from .services.api import create_app
        bus = _bus(settings, "api")
        uvicorn.run(create_app(settings, reg, db, bus), host=args.host, port=args.port, log_level="info")
        return

    if args.cmd == "sensors":
        from .hal import make_hal
        from .services.sensors import SensorService
        bus = _bus(settings, "sensors")
        svc = SensorService(reg, db, bus, make_hal(settings.hal, reg))
        svc.start()
        _wait_forever([svc.stop, bus.stop])
        return

    if args.cmd == "control":
        from .hal import make_hal
        from .services.control import ControlService
        bus = _bus(settings, "control", will=(topics.status, {"online": False}))
        hal = make_hal(settings.hal, reg)
        svc = ControlService(reg, db, bus, hal, cycle_s=settings.cycle_s_override, network_mode=settings.network_mode)
        svc.start()

        def _shutdown():
            svc.stop()
            bus.publish(topics.status, {"online": False, "ts": iso(utcnow())}, retain=True, qos=1)
            hal.close()
            bus.stop()
        _wait_forever([_shutdown])
        return

    if args.cmd == "sync":
        from .services.sync import SyncService
        if not settings.cloud_url or not settings.sync_token:
            sys.exit("GH_CLOUD_URL and GH_SYNC_TOKEN are required")
        svc = SyncService(db, settings.cloud_url, settings.sync_token, settings.sync_interval_s)
        svc.start()
        _wait_forever([svc.stop])
        return

    if args.cmd == "sim-nodes":
        from .hal.sim import Environment
        from .services.simnodes import SimNodes
        bus = _bus(settings, "simnodes")
        svc = SimNodes(reg, bus, Environment(reg), args.interval)
        svc.start()
        _wait_forever([svc.stop, bus.stop])
        return

    if args.cmd == "dev":
        run_dev(settings, reg, db, args)


def run_dev(settings: Settings, reg, db, args) -> None:
    """All services in one process on the simulator. Uses MQTT if GH_MQTT_HOST points at a broker,
    otherwise an in-memory bus (the app then uses REST polling instead of WebSocket)."""
    import uvicorn

    from .bus import Topics
    from .hal.sim import Environment, SimHal
    from .models import User
    from .services.api import create_app
    from .services.control import ControlService
    from .services.sensors import SensorService
    from .services.simnodes import SimNodes

    if "GH_MQTT_HOST" not in os.environ:
        settings.mqtt_host = "memory"
    settings.enable_sim_api = True
    n = _seed_sim_calibrations(db, reg)
    with db.session() as s:
        has_users = s.query(User).count() > 0
    if not has_users:
        create_user(db, "admin@greenhouse.local", "greenhouse", "Dev Administrator", "admin")
        print("\n  Dev login:  admin@greenhouse.local  /  greenhouse\n")
    topics = Topics(reg.greenhouse_id)
    env = Environment(reg)
    bus = _bus(settings, "dev", will=(topics.status, {"online": False}))
    hal = SimHal(reg, env)
    sensors = SensorService(reg, db, bus, hal)
    control = ControlService(reg, db, bus, hal, cycle_s=args.cycle, network_mode="dev")
    nodes = SimNodes(reg, bus, env, args.interval)
    sensors.start()
    nodes.start()
    control.start()
    log.info("dev mode: %s, %d simulator calibrations seeded; API on http://%s:%d (docs at /docs)",
             "MQTT " + settings.mqtt_host if settings.mqtt_host != "memory" else "in-memory bus", n, args.host, args.port)
    uvicorn.run(create_app(settings, reg, db, bus), host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
