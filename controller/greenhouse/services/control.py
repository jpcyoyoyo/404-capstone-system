"""greenhouse-control: runs the ControlEngine against live readings and real (or simulated) outputs.

Integration Plan §3.1: "Subscribes to readings, evaluates thresholds, applies arbitration
and interlocks, drives actuators, raises alerts."
"""
from __future__ import annotations

import logging
import os
import threading
from datetime import datetime
from typing import Any

from sqlalchemy import select, update

from ..bus import Bus, Topics
from ..control.engine import CommandIn, CommandResult, ControlEngine, TickResult
from ..control.types import AlertSignal, Band, Change, Reading
from ..db import Database
from ..hal import Hal
from ..models import Actuator, ActuatorEvent, AuditLog, Command, FertigationDose, Threshold
from ..registry import Registry
from ..seed import DEFAULT_STAGE_KEY
from ..timeutil import iso, parse_iso, utcnow
from .common import AlertManager

log = logging.getLogger(__name__)


class ControlService:
    def __init__(self, reg: Registry, db: Database, bus: Bus, hal: Hal, cycle_s: float | None = None,
                 network_mode: str = "unknown"):
        self.reg, self.db, self.bus, self.hal = reg, db, bus, hal
        self.topics = Topics(reg.greenhouse_id)
        self.cycle_s = cycle_s or float(reg.control.get("cycle_s", 30))
        self.network_mode = network_mode
        self.lock = threading.RLock()
        self.engine = ControlEngine(reg, utcnow())
        self.engine.cycle_s = self.cycle_s
        self.alerts = AlertManager(db, bus, self.topics, owner="control")
        self._stop = threading.Event()
        self._last_published: dict[str, tuple] = {}
        self._last_deferred: dict[str, str] = {}
        self._last_result: TickResult | None = None
        self.load_config()

    # ── configuration from the database ──────────────────────────────────
    def load_config(self) -> None:
        stage = self.db.kv_get(DEFAULT_STAGE_KEY) or self.reg.stages[0].id
        with self.db.session() as s:
            rows = s.execute(select(Threshold).where(Threshold.stage_id == stage)).scalars().all()
            bands = {t.parameter: Band(t.min_value, t.max_value, t.deadband) for t in rows}
        with self.lock:
            self.engine.set_stage(stage, bands or None)
        log.info("control config: stage=%s, %d thresholds", stage, len(bands))

    # ── lifecycle ────────────────────────────────────────────────────────
    def start(self) -> None:
        with self.lock:
            changes = self.engine.boot(utcnow())
        self._apply(changes, utcnow())
        self.bus.subscribe(self.topics.reading(), self._on_reading)
        self.bus.subscribe(self.topics.node_status(), self._on_node_status)
        self.bus.subscribe(self.topics.cmd(), self._on_cmd, qos=1)
        self.bus.subscribe(self.topics.config_changed, self._on_config)
        threading.Thread(target=self._loop, name="control-loop", daemon=True).start()
        log.info("control service started (cycle %.0f s)", self.cycle_s)

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception:
                log.exception("control tick failed")
            self._stop.wait(self.cycle_s)

    # ── inputs ───────────────────────────────────────────────────────────
    def _on_reading(self, topic: str, p: dict) -> None:
        sid = p.get("sensor_id")
        if not sid or not self.reg.has_sensor(sid):
            return
        ts = parse_iso(p.get("ts")) or utcnow()
        with self.lock:
            self.engine.update_reading(Reading(sid, p.get("type", ""), int(p.get("zone_id", 0)),
                                               p.get("value"), p.get("quality", "INVALID"), ts))

    def _on_node_status(self, topic: str, p: dict) -> None:
        node = Topics.segment(topic, 3)
        with self.lock:
            was = self.engine.node_online.get(node, True)
            self.engine.set_node_online(node, bool(p.get("online")))
        if was != bool(p.get("online")):
            log.warning("node %s is now %s", node, "online" if p.get("online") else "OFFLINE")
            self.tick()

    def _on_config(self, topic: str, p: dict) -> None:
        if p.get("what") in ("thresholds", "stage"):
            self.load_config()
            self.tick()

    # ── the loop ─────────────────────────────────────────────────────────
    def tick(self, now: datetime | None = None) -> TickResult:
        now = now or utcnow()
        with self.lock:
            res = self.engine.tick(now)
            self._last_result = res
        self._apply(res.changes, now)
        self._record(res, now)
        if res.dose_request_g:
            self._start_dose(res.dose_request_g, "system", None, "auto")
        self._publish_status(res, now)
        return res

    def _apply(self, changes: list[Change], now: datetime) -> None:
        if not changes:
            return
        events = []
        for c in changes:
            adef = self.reg.actuator(c.actuator)
            try:
                self.hal.set_output(adef, c.on)
            except Exception as e:
                # The engine already believes the change happened; surface the hardware fault loudly.
                log.exception("output %s failed", c.actuator)
                self.alerts.sync([AlertSignal(f"{c.actuator}:hal:{now.isoformat()}", "high", c.actuator,
                                              "ACTUATOR_FAULT", f"{adef.name}: output failed ({e})", kind="event")], now)
            events.append(ActuatorEvent(actuator_id=c.actuator, action="ON" if c.on else "OFF", reason=c.reason[:255],
                                        source=c.source, cmd_id=c.cmd_id, issued_by="system", occurred_at=now))
            log.info("%s %s — %s [%s]", c.actuator, "ON" if c.on else "OFF", c.reason, c.source)
        with self.db.session() as s:
            s.add_all(events)
            for c in changes:
                row = s.get(Actuator, c.actuator)
                if row:
                    row.state, row.last_changed = c.on, now

    def _record(self, res: TickResult, now: datetime) -> None:
        rows = []
        for sup in res.new_suppressed:
            rows.append(ActuatorEvent(actuator_id=sup.actuator, action="SUPPRESSED", reason=sup.reason[:255],
                                      source="auto", occurred_at=now,
                                      detail={"wanted_on": sup.wanted_on, "source": sup.source, "rule": sup.rule,
                                              "by_source": sup.by_source, "by_rule": sup.by_rule}))
        current = {}
        for d in res.deferred:
            key = f"{d.target_on}:{d.reason}"
            current[d.actuator] = key
            if self._last_deferred.get(d.actuator) != key:
                rows.append(ActuatorEvent(actuator_id=d.actuator, action="DEFERRED", source="auto", occurred_at=now,
                                          reason=f"{'ON' if d.target_on else 'OFF'} deferred: {d.reason}"
                                                 + (f" ({d.retry_s:.0f} s)" if d.retry_s else "")))
        self._last_deferred = current
        for aid, mode, why in res.mode_changes:
            rows.append(ActuatorEvent(actuator_id=aid, action=f"MODE_{mode}", reason=why, source="auto", occurred_at=now))
        if rows:
            with self.db.session() as s:
                s.add_all(rows)
                for aid, mode, _ in res.mode_changes:
                    row = s.get(Actuator, aid)
                    if row:
                        row.mode = mode
        self.alerts.sync(res.alerts, now)

    def _network_mode(self) -> str:
        """greenhouse-net writes the current mode (magso | router | hotspot) to a small file."""
        path = os.environ.get("GH_NETWORK_MODE_FILE", "/run/greenhouse/network_mode")
        try:
            with open(path, encoding="utf-8") as f:
                return f.read().strip() or self.network_mode
        except OSError:
            return self.network_mode

    def _publish_status(self, res: TickResult | None, now: datetime) -> None:
        with self.lock:
            views = [self.engine.actuator_view(a.id, res.lockouts if res else None) for a in self.reg.physical_actuators]
            irr = self.engine.irrigation_view()
            stage = self.engine.stage_id
        for v in views:
            payload = {**v, "manual_until": iso(v["manual_until"]), "since": iso(v["since"]), "ts": iso(now)}
            key = (payload["on"], payload["mode"], payload["manual_until"], payload["lockout"])
            if self._last_published.get(v["actuator_id"]) != key:
                self.bus.publish(self.topics.actuator_state(v["actuator_id"]), payload, retain=True, qos=1)
                self._last_published[v["actuator_id"]] = key
        irr_payload = {**irr, "manual_until": iso(irr["manual_until"]), "installed": True, "lockout":
                       (res.lockouts.get("pump") if res else None), "ts": iso(now)}
        key = (irr_payload["on"], irr_payload["mode"], irr_payload["manual_until"], irr_payload["circuit"], irr_payload["lockout"])
        if self._last_published.get("irrigation") != key:
            self.bus.publish(self.topics.actuator_state("irrigation"), irr_payload, retain=True, qos=1)
            self._last_published["irrigation"] = key
        zones = {}
        if res:
            for t, ps in res.params.items():
                zones[t] = {"value": ps.value, "manual_required": ps.manual_required_zones,
                            "zones": {str(z): {"median": zv.median, "valid": zv.n_valid, "total": zv.n_total}
                                      for z, zv in ps.zones.items()}}
        self.bus.publish(self.topics.status, {"online": True, "service": "control", "ts": iso(now),
                                              "active_stage": stage, "network_mode": self._network_mode(),
                                              "cycle_s": self.cycle_s, "params": zones,
                                              "nodes": dict(self.engine.node_online)}, retain=True, qos=1)

    # ── commands ─────────────────────────────────────────────────────────
    def _on_cmd(self, topic: str, p: dict) -> None:
        try:
            self.handle_command(p)
        except Exception:
            log.exception("command handling failed: %s", p)

    def handle_command(self, p: dict) -> dict[str, Any]:
        now = utcnow()
        cmd_id = str(p.get("cmd_id", ""))
        aid = p.get("actuator_id", "")
        if not cmd_id:
            return {}
        # Claim the row. The API may have already given up (EXPIRED) — then we must not execute.
        with self.db.session() as s:
            row = s.get(Command, cmd_id)
            if row is None:
                row = Command(cmd_id=cmd_id, actuator_id=aid, action=p.get("action", ""), duration_s=p.get("duration_s"),
                              target_g=p.get("target_g"), circuit=p.get("circuit"), issued_by=p.get("issued_by", "unknown"),
                              reason=p.get("reason", "MANUAL_OVERRIDE"), status="PENDING",
                              issued_at=parse_iso(p.get("ts")) or now, received_at=now)
                s.add(row)
                s.flush()
            claimed = s.execute(update(Command).where(Command.cmd_id == cmd_id, Command.status == "PENDING")
                                .values(status="PROCESSING")).rowcount
            snapshot = (row.status, row.status_reason, row.message)
        if not claimed:
            status, reason, message = snapshot
            if status in ("ACCEPTED", "REJECTED", "EXPIRED"):
                ack = self._ack(aid, cmd_id, status, reason, message, now)   # idempotent replay
                return ack
            return {}

        issued = parse_iso(p.get("ts")) or now
        if aid == "all" and p.get("action") == "ESTOP":
            with self.lock:
                changes = self.engine.estop(now, p.get("issued_by", "unknown"))
            self._apply(changes, now)
            who = p.get("issued_by", "unknown")
            self.alerts.sync([AlertSignal(f"estop:{now.isoformat()}", "high", who, "ESTOP",
                                          f"Emergency stop by {who}: all outputs off and held in manual", kind="event")], now)
            result = CommandResult("ACCEPTED", None, "emergency stop: all outputs off, held for 30 min")
            self._audit(p, result, now)
            self._finish(cmd_id, result, now)
            self._publish_status(self._last_result, now)
            return self._ack(aid, cmd_id, result.status, result.reason, result.message, now)

        cmd = CommandIn(cmd_id=cmd_id, actuator_id=aid, action=str(p.get("action", "")).upper(), issued_at=issued,
                        issued_by=p.get("issued_by", "unknown"), duration_s=p.get("duration_s"),
                        target_g=p.get("target_g"), circuit=p.get("circuit"))
        with self.lock:
            result = self.engine.command(cmd, now)
        self._finish(cmd_id, result, now)
        self._audit(p, result, now)
        ack = self._ack(aid, cmd_id, result.status, result.reason, result.message, now)
        if result.status == "ACCEPTED":
            if result.dose_g:
                self._start_dose(result.dose_g, cmd.issued_by, cmd_id, "manual")
            with self.db.session() as s:
                s.add(ActuatorEvent(actuator_id=aid, action=f"CMD_{cmd.action}", reason=result.message or "",
                                    source="manual", issued_by=cmd.issued_by, cmd_id=cmd_id, occurred_at=now,
                                    duration_s=cmd.duration_s))
            self.tick(now)
        return ack

    def _finish(self, cmd_id: str, r: CommandResult, now: datetime) -> None:
        with self.db.session() as s:
            s.execute(update(Command).where(Command.cmd_id == cmd_id).values(
                status=r.status, status_reason=r.reason, message=(r.message or "")[:255], resolved_at=now))

    def _audit(self, p: dict, r: CommandResult, now: datetime) -> None:
        with self.db.session() as s:
            s.add(AuditLog(actor=p.get("issued_by", "unknown"), action=f"command_{r.status.lower()}",
                           target=f"actuator:{p.get('actuator_id')}", occurred_at=now,
                           detail={"cmd_id": p.get("cmd_id"), "action": p.get("action"), "duration_s": p.get("duration_s"),
                                   "circuit": p.get("circuit"), "target_g": p.get("target_g"),
                                   "reason": r.reason, "message": r.message}))

    def _ack(self, aid: str, cmd_id: str, status: str, reason: str | None, message: str | None, now: datetime) -> dict:
        ack = {"cmd_id": cmd_id, "status": status, "reason": reason, "message": message, "ts": iso(now)}
        self.bus.publish(self.topics.ack(aid or "all"), ack, qos=1)
        return ack

    # ── fertigation ──────────────────────────────────────────────────────
    def _start_dose(self, grams: float, by: str, cmd_id: str | None, source: str) -> None:
        with self.lock:
            self.engine.dosing = True
        fert = self.reg.control.get("fertigation", {})

        def clear() -> bool:
            with self.lock:
                res = self._last_result
                stop = self.engine.dose_stop_requested
            return not stop and not (res and res.lockouts.get("auger") not in (None, "DOSING"))

        def run() -> None:
            started = utcnow()
            try:
                r = self.hal.dose(grams, float(fert.get("tolerance_g", 2)), float(fert.get("max_dose_time_s", 120)), clear)
            except Exception as e:
                log.exception("dose failed")
                from ..hal import DoseResult
                r = DoseResult(0.0, "aborted", f"ERROR: {e}"[:60])
            finished = utcnow()
            with self.lock:
                stopped = self.engine.dose_stop_requested
            if stopped and r.status != "complete":
                from ..hal import DoseResult
                r = DoseResult(r.delivered_g, "aborted", "STOPPED")
            with self.db.session() as s:
                s.add(FertigationDose(target_g=grams, delivered_g=r.delivered_g, status=r.status, reason=r.reason,
                                      source=source, issued_by=by, cmd_id=cmd_id, started_at=started, finished_at=finished))
                s.add(ActuatorEvent(actuator_id="auger", action="DOSE", source=source, issued_by=by, cmd_id=cmd_id,
                                    reason=f"target {grams:g} g, delivered {r.delivered_g:g} g ({r.status}{' ' + r.reason if r.reason else ''})",
                                    duration_s=(finished - started).total_seconds(), occurred_at=finished))
            if r.status != "complete" and r.reason != "STOPPED":
                self.alerts.sync([AlertSignal(f"auger:{r.reason}:{finished.isoformat()}", "high", "auger", r.reason or "DOSE_ABORTED",
                                              f"Dose aborted after {r.delivered_g:g} of {grams:g} g ({r.reason})", kind="event")], finished)
            with self.lock:
                self.engine.dose_finished(finished)
            log.info("dose %s: target %.1f g delivered %.1f g %s", r.status, grams, r.delivered_g, r.reason)

        threading.Thread(target=run, name="auger-dose", daemon=True).start()
