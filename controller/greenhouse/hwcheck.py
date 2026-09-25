"""`greenhouse hw …` — bench and commissioning checks through the same drivers the services use.

Every pin and channel comes from contract/registry.yaml, so a check that passes here proves the
wiring AND the registry agree. Used by the Component Assembly Procedures (Sections A–C).

  greenhouse hw list                         what is wired where, per the registry
  greenhouse hw read ph_01 --count 10        raw and calibrated readings from Pi-attached sensors
  greenhouse hw distance level_01            raw ultrasonic distance (blind zone, tank depth)
  greenhouse hw on lights --seconds 5        drive one output, then switch it off again
  greenhouse hw relay IN5 --seconds 2        click one relay input (or `all`), even unassigned or not-installed ones
  greenhouse hw servo servo_main --pulse 1500
  greenhouse hw jog --steps 200 [--reverse]  turn the auger stepper
  greenhouse hw dose --grams 20              closed-loop dose against the load cell
  greenhouse hw watch [--node node_a]        print node MQTT messages as they arrive
  greenhouse hw clear-sim-calibrations       remove the simulator's calibration constants (before real sensors)

Stop greenhouse-sensors and greenhouse-control before using outputs or the same sensors
(`sudo systemctl stop greenhouse-control greenhouse-sensors`): two programs cannot own a GPIO.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import time
from datetime import timedelta

from . import quality
from .registry import Registry
from .timeutil import utcnow


def _services_running() -> list[str]:
    if not shutil.which("systemctl"):
        return []
    running = []
    for svc in ("greenhouse-control", "greenhouse-sensors"):
        r = subprocess.run(["systemctl", "is-active", "--quiet", svc], capture_output=True)
        if r.returncode == 0:
            running.append(svc)
    return running


def _guard(force: bool) -> None:
    running = _services_running()
    if running and not force:
        sys.exit(f"Stop {', '.join(running)} first:  sudo systemctl stop {' '.join(running)}\n"
                 "(or pass --force if you know they are not using this device)")


def _actuator(reg: Registry, aid: str):
    try:
        return reg.actuator(aid)
    except Exception:
        sys.exit(f"No actuator '{aid}'. Known: {', '.join(a.id for a in reg.physical_actuators)}")


def _sensor(reg: Registry, sid: str):
    for s in reg.sensors:
        if s.id == sid:
            return s
    sys.exit(f"No sensor '{sid}'. Known: {', '.join(s.id for s in reg.sensors)}")


def cmd_list(reg: Registry) -> None:
    print("SENSORS")
    for s in reg.sensors:
        where = ", ".join(f"{k}={v}" for k, v in s.extra.items()
                          if k in ("device", "channel", "pin", "port", "dt_pin", "sck_pin", "divider"))
        flag = "" if s.installed else "   [not installed]"
        print(f"  {s.id:<12} {s.type:<18} zone {s.zone}  {s.host:<7} {where}{flag}")
    print("\nACTUATORS")
    inputs = reg.relay_board.get("inputs", {})
    for a in reg.physical_actuators:
        e = a.extra
        if a.kind == "relay":
            chans = [e["channel"]] + list(e.get("also", []) or [])
            where = " + ".join(f"{c} ({inputs.get(c)})" for c in chans)
        elif a.kind == "ssr":
            where = f"SSR input on {e['pin']}"
        elif a.kind == "servo":
            where = f"PCA9685 ch{e['pca9685_channel']} (open {e.get('open_pulse_us')} µs, closed {e.get('closed_pulse_us')} µs)"
        elif a.kind == "stepper":
            where = f"STEP {e['step_pin']}, DIR {e['dir_pin']}"
        else:
            where = a.kind
        flag = "" if a.installed else "   [not installed]"
        print(f"  {a.id:<16} {where}{flag}")
    print(f"\nRelay board active-{'LOW' if reg.relay_board.get('active_low', True) else 'HIGH'}")


def cmd_read(reg: Registry, hal, db, ids: list[str], count: int, interval: float) -> None:
    from .services.common import CalibrationStore
    sensors = [_sensor(reg, i) for i in ids] if ids else [s for s in reg.sensors if s.host == "pi" and s.installed]
    remote = [s.id for s in sensors if s.host != "pi"]
    if remote:
        sys.exit(f"{', '.join(remote)} are read by a sensing node; use `greenhouse hw watch` instead.")
    cal = CalibrationStore(db) if db is not None else None
    started = utcnow() - timedelta(hours=1)   # outside CO2 warm-up for display purposes
    print(f"{'sensor':<12} {'raw':>12} {'value':>10} {'unit':<6} quality")
    for n in range(count):
        for smp in hal.read_local(sensors):
            sd = next(s for s in sensors if s.id == smp.sensor_id)
            value, q = quality.evaluate(sd, smp.raw, smp.ok, cal.get(sd.id) if cal else None, utcnow(), started)
            raw = "—" if smp.raw is None else f"{smp.raw:.5g}"
            val = "—" if value is None else f"{value:.4g}"
            note = f"  ({smp.error})" if smp.error and not smp.ok else ""
            print(f"{sd.id:<12} {raw:>12} {val:>10} {sd.unit:<6} {q}{note}")
        if n < count - 1:
            time.sleep(interval)


def cmd_distance(reg: Registry, hal, sid: str, count: int, interval: float) -> None:
    sd = _sensor(reg, sid)
    for n in range(count):
        d = hal.ultrasonic_distance_cm(sd)
        print("no valid frame (check wiring, baud, or blind zone)" if d is None else f"{d:.1f} cm")
        if n < count - 1:
            time.sleep(interval)


def cmd_on(reg: Registry, hal, aid: str, seconds: float, yes: bool) -> None:
    a = _actuator(reg, aid)
    if not a.installed:
        sys.exit(f"{aid} is marked installed: false in the registry.")
    if aid == "pump" and not yes:
        sys.exit("The pressure washer must only run with water in the reservoir, the regulator fitted and a "
                 "valve open. Add --yes when that is true.")
    print(f"{aid} ON for {seconds:g} s …", flush=True)
    try:
        hal.set_output(a, True)
        time.sleep(seconds)
    finally:
        hal.set_output(a, False)
        print(f"{aid} OFF")


def cmd_relay(settings, reg: Registry, which: str, seconds: float) -> None:
    inputs = reg.relay_board.get("inputs", {})
    chans = list(inputs) if which.lower() == "all" else [which.upper()]
    unknown = [c for c in chans if c not in inputs]
    if unknown:
        sys.exit(f"No relay input {', '.join(unknown)}. Known: {', '.join(inputs)} or all")
    if [c for c in chans if c == "IN1"] and which.lower() != "in1":
        print("note: IN1 feeds the pressure-washer SSR — disconnect its output wire for this test")
    active_high = not bool(reg.relay_board.get("active_low", True))
    factory = None
    if settings.hal == "pi":
        from gpiozero.pins.lgpio import LGPIOFactory
        from .hal.pi import rp1_chip
        factory = LGPIOFactory(chip=rp1_chip())
    for ch in chans:
        pin = inputs[ch]
        print(f"{ch} ({pin}) ON for {seconds:g} s …", flush=True)
        if factory is None:
            time.sleep(seconds)
            print(f"{ch} OFF   (simulator: nothing physical moved)")
            continue
        from gpiozero import OutputDevice
        dev = OutputDevice(int(str(pin).upper().replace("GPIO", "")), active_high=active_high,
                           initial_value=False, pin_factory=factory)
        try:
            dev.on()
            time.sleep(seconds)
        finally:
            dev.off()
            dev.close()
        print(f"{ch} OFF")
        time.sleep(0.5)


def cmd_servo(reg: Registry, hal, aid: str, pulse: float, hold: float) -> None:
    a = _actuator(reg, aid)
    if a.kind != "servo":
        sys.exit(f"{aid} is not a servo")
    ch = int(a.extra["pca9685_channel"])
    print(f"{aid} (ch{ch}) → {pulse:g} µs for {hold:g} s")
    hal.servo_pulse(ch, pulse)
    time.sleep(hold)
    hal.servo_pulse(ch, 0)
    print("released")


def cmd_jog(hal, steps: int, reverse: bool) -> None:
    print(f"auger {'reverse' if reverse else 'forward'} {steps} steps")
    t0 = time.monotonic()
    hal.jog(steps, reverse)
    print(f"done in {time.monotonic() - t0:.1f} s")


def cmd_dose(reg: Registry, hal, db, grams: float) -> None:
    from .services.common import CalibrationStore
    hopper = next((s for s in reg.sensors if s.type == "hopper_weight"), None)
    if hopper is None:
        sys.exit("No hopper_weight sensor in the registry.")
    consts = CalibrationStore(db).get(hopper.id) if db is not None else None
    if not consts:
        sys.exit("The load cell has no calibration yet (Calibration screen → hopper_01, or procedure A13).")
    hal.hopper_constants = consts
    fert = reg.control.get("fertigation", {})
    print(f"dosing {grams:g} g …", flush=True)
    r = hal.dose(grams, float(fert.get("tolerance_g", 2)), float(fert.get("max_dose_time_s", 120)), lambda: True)
    print(f"{r.status}: delivered {r.delivered_g:g} g (error {r.delivered_g - grams:+.1f} g){' ' + r.reason if r.reason else ''}")


def cmd_watch(settings, reg: Registry, node: str | None, seconds: float) -> None:
    from .bus import Topics, make_bus
    if settings.mqtt_host == "memory":
        sys.exit("GH_MQTT_HOST is not set; `hw watch` needs the real broker.")
    topics = Topics(reg.greenhouse_id)
    bus = make_bus(settings, f"greenhouse-hwwatch-{int(time.time())}")

    def show(topic: str, payload: dict) -> None:
        print(time.strftime("%H:%M:%S"), topic, json.dumps(payload, ensure_ascii=False)[:400], flush=True)

    bus.subscribe(topics.node_raw(node or "+"), show)
    bus.subscribe(topics.node_status(node or "+"), show)
    bus.start()
    print(f"listening on {topics.node_raw(node or '+')} for {seconds:g} s (Ctrl+C to stop)")
    try:
        time.sleep(seconds)
    except KeyboardInterrupt:
        pass
    bus.stop()


def cmd_clear_sim(db) -> None:
    from sqlalchemy import delete, select
    from .models import Calibration, Sensor
    with db.session() as s:
        ids = [c.sensor_id for c in s.execute(select(Calibration).where(Calibration.performed_by == "simulator")).scalars()]
        s.execute(delete(Calibration).where(Calibration.performed_by == "simulator"))
        for sid in set(ids):
            row = s.get(Sensor, sid)
            if row is not None:
                row.calibrated_at = None
    print(f"removed {len(ids)} simulator calibration(s); these sensors now read UNCALIBRATED until calibrated for real:")
    for sid in sorted(set(ids)):
        print("  ", sid)


def add_parser(sub) -> None:
    h = sub.add_parser("hw", help="bench and commissioning checks")
    hs = h.add_subparsers(dest="hw", required=True)
    hs.add_parser("list")
    r = hs.add_parser("read"); r.add_argument("ids", nargs="*"); r.add_argument("--count", type=int, default=1)
    r.add_argument("--interval", type=float, default=2.0); r.add_argument("--force", action="store_true")
    d = hs.add_parser("distance"); d.add_argument("id", nargs="?", default="level_01")
    d.add_argument("--count", type=int, default=5); d.add_argument("--interval", type=float, default=1.0)
    d.add_argument("--force", action="store_true")
    o = hs.add_parser("on"); o.add_argument("id"); o.add_argument("--seconds", type=float, default=3.0)
    o.add_argument("--yes", action="store_true"); o.add_argument("--force", action="store_true")
    rl = hs.add_parser("relay"); rl.add_argument("input", help="IN1…IN8 or all")
    rl.add_argument("--seconds", type=float, default=2.0); rl.add_argument("--force", action="store_true")
    s = hs.add_parser("servo"); s.add_argument("id"); s.add_argument("--pulse", type=float, required=True)
    s.add_argument("--hold", type=float, default=2.0); s.add_argument("--force", action="store_true")
    j = hs.add_parser("jog"); j.add_argument("--steps", type=int, default=200); j.add_argument("--reverse", action="store_true")
    j.add_argument("--force", action="store_true")
    ds = hs.add_parser("dose"); ds.add_argument("--grams", type=float, required=True); ds.add_argument("--force", action="store_true")
    w = hs.add_parser("watch"); w.add_argument("--node", default=None); w.add_argument("--seconds", type=float, default=120)
    hs.add_parser("clear-sim-calibrations")


def run(args, settings, reg: Registry, db) -> None:
    from .hal import make_hal
    if args.hw == "list":
        return cmd_list(reg)
    if args.hw == "watch":
        return cmd_watch(settings, reg, args.node, args.seconds)
    if args.hw == "clear-sim-calibrations":
        return cmd_clear_sim(db)
    _guard(getattr(args, "force", False))
    if args.hw == "relay":   # drives raw inputs directly; must not share pins with a HAL instance
        return cmd_relay(settings, reg, args.input, args.seconds)
    hal = make_hal(settings.hal, reg)
    try:
        if args.hw == "read":
            cmd_read(reg, hal, db, args.ids, args.count, args.interval)
        elif args.hw == "distance":
            cmd_distance(reg, hal, args.id, args.count, args.interval)
        elif args.hw == "on":
            cmd_on(reg, hal, args.id, args.seconds, args.yes)
        elif args.hw == "servo":
            cmd_servo(reg, hal, args.id, args.pulse, args.hold)
        elif args.hw == "jog":
            cmd_jog(hal, args.steps, args.reverse)
        elif args.hw == "dose":
            cmd_dose(reg, hal, db, args.grams)
    finally:
        hal.close()
