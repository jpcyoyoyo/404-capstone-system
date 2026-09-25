"""ControlEngine — the 30-second control loop and the manual-command path, with no I/O.

tick() performs the seven operations of Integration Plan §3.2 in a fixed order,
so that no threshold comparison can ever override an interlock:

  1 acquire readings (with quality flags)      2 aggregate by zone (median)
  3 evaluate sensor health                      4 evaluate interlocks
  5 evaluate thresholds for the active stage    6 arbitrate by precedence
  7 apply decisions through the actuator guard (min on/off, max run, caps)

The service layer (services/control.py) feeds readings in, applies the returned
Changes to the hardware, persists events and publishes state.
"""
from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from ..registry import Registry
from ..timeutil import local_time_of
from . import guard as G
from .aggregate import aggregate
from .arbitration import arbitrate
from .rules import (climate_requests, fertigation_gate, fertigation_request, irrigation_request,
                    lighting_request)
from .types import (RULE_CONTENTION, RULE_SAFETY, RULE_THRESHOLD, AlertSignal, Band, Change, ParamState,
                    Reading, Request, Suppressed)

PARAM_TYPES = ["soil_moisture", "temperature", "humidity", "light", "co2", "ph", "ec", "water_level"]
IRRIGATION_ACTS = ("pump", "servo_main", "valve_fog", "valve_drip", "valve_sprinkler")


@dataclass
class CommandIn:
    cmd_id: str
    actuator_id: str
    action: str                     # ON | OFF | AUTO | DOSE
    issued_at: datetime
    issued_by: str = "unknown"
    duration_s: int | None = None
    target_g: float | None = None
    circuit: str | None = None


@dataclass
class CommandResult:
    status: str                     # ACCEPTED | REJECTED | EXPIRED
    reason: str | None = None
    message: str | None = None
    dose_g: float | None = None     # set when an auger dose should start


@dataclass
class Deferred:
    actuator: str
    target_on: bool
    reason: str
    retry_s: float


@dataclass
class TickResult:
    changes: list[Change] = field(default_factory=list)
    suppressed: list[Suppressed] = field(default_factory=list)
    new_suppressed: list[Suppressed] = field(default_factory=list)
    deferred: list[Deferred] = field(default_factory=list)
    alerts: list[AlertSignal] = field(default_factory=list)
    params: dict[str, ParamState] = field(default_factory=dict)
    lockouts: dict[str, str] = field(default_factory=dict)
    mode_changes: list[tuple[str, str, str]] = field(default_factory=list)  # (actuator, new_mode, why)
    dose_request_g: float | None = None


class ControlEngine:
    def __init__(self, reg: Registry, now: datetime):
        self.reg = reg
        self.cfg = reg.control
        self.cycle_s = float(self.cfg.get("cycle_s", 30))
        self.started_at = now
        self.state: dict[str, G.ActState] = {a.id: G.ActState(since=now) for a in reg.physical_actuators}
        self.readings: dict[str, Reading] = {}
        self.node_online: dict[str, bool] = {n.id: True for n in reg.nodes}
        self.stage_id = reg.stages[0].id
        self.bands: dict[str, Band] = self._default_bands(self.stage_id)
        self.irrigation_manual: dict[str, Any] | None = None
        self._seen: OrderedDict[str, CommandResult] = OrderedDict()
        self._last_suppressed: set[tuple] = set()
        self.dosing = False
        self.dose_stop_requested = False
        self.last_dose_at: datetime | None = None
        # True while the pump is running because the soil-moisture rule started it. The rule's
        # "hold inside the deadband" only applies to its own irrigation, not to one an operator started.
        self._irr_by_auto = False

    # ── configuration ────────────────────────────────────────────────────
    def _default_bands(self, stage_id: str) -> dict[str, Band]:
        return {p: Band(lo, hi, self.reg.deadbands.get(p, 0.0))
                for p, (lo, hi) in self.reg.default_thresholds[stage_id].items()}

    def set_stage(self, stage_id: str, bands: dict[str, Band] | None = None) -> None:
        self.reg.stage(stage_id)  # validates
        self.stage_id = stage_id
        self.bands = bands if bands is not None else self._default_bands(stage_id)

    @property
    def stage_circuit(self) -> str:
        return self.reg.stage(self.stage_id).irrigation_mode

    # ── inputs ───────────────────────────────────────────────────────────
    def update_reading(self, r: Reading) -> None:
        self.readings[r.sensor_id] = r

    def set_node_online(self, node_id: str, online: bool) -> None:
        self.node_online[node_id] = online

    def _stale_after(self, sensor_interval: float) -> float:
        return float(self.cfg.get("stale_after_cycles", 3)) * max(sensor_interval, self.cycle_s)

    def effective_readings(self, now: datetime) -> dict[str, Reading]:
        """Readings as the loop should see them: aged-out or orphaned ones become STALE."""
        eff: dict[str, Reading] = {}
        for sd in self.reg.sensors:
            if not sd.installed:
                continue
            r = self.readings.get(sd.id)
            if r is None:
                continue
            stale = (now - r.ts).total_seconds() > self._stale_after(sd.interval_s)
            if sd.on_node and not self.node_online.get(sd.host, True):
                stale = True
            if stale and r.quality != "STALE":
                r = Reading(r.sensor_id, r.type, r.zone, None, "STALE", r.ts)
            eff[sd.id] = r
        return eff

    # ── lockouts (safety, §3.5 rule 1) ───────────────────────────────────
    def lockouts(self, eff: dict[str, Reading], params: dict[str, ParamState]) -> dict[str, str]:
        out: dict[str, str] = {}
        for a in self.reg.physical_actuators:
            if not a.installed:
                out[a.id] = "NOT_INSTALLED"
        if self.reg.has_actuator("pump") and "pump" not in out:
            floats = self.reg.sensors_of("float_switch")
            if floats:
                fr = eff.get(floats[0].id)
                if fr is None or not fr.valid:
                    out["pump"] = "FLOAT_SWITCH_FAULT"
                elif fr.value < 0.5:
                    out["pump"] = "LOW_WATER"
            lvl = params.get("water_level")
            min_pct = float(self.cfg.get("reservoir_min_level_pct", 0))
            if "pump" not in out and lvl is not None and lvl.value is not None and lvl.value < min_pct:
                out["pump"] = "LOW_WATER"
        if self.dosing:
            out["auger"] = "DOSING"
        return out

    # ── manual overrides ─────────────────────────────────────────────────
    def _expire_manual(self, now: datetime, res: TickResult) -> None:
        if self.irrigation_manual and self.irrigation_manual["until"] <= now:
            res.mode_changes.append(("irrigation", "AUTO", "manual override expired"))
            self.irrigation_manual = None
        for aid, st in self.state.items():
            if st.mode == "MANUAL" and st.manual_until and st.manual_until <= now:
                st.mode, st.manual_on, st.manual_until, st.manual_cmd = "AUTO", None, None, None
                res.mode_changes.append((aid, "AUTO", "manual override expired"))

    def _manual_cap(self, water: bool) -> float:
        return float(self.cfg.get("manual_override_max_s", 1800)) if water else 12 * 3600.0

    # ── the loop ─────────────────────────────────────────────────────────
    def boot(self, now: datetime) -> list[Change]:
        """Controller restart: every output de-energised; nothing resumes automatically (§3.6)."""
        changes = []
        for a in self.reg.physical_actuators:
            st = self.state[a.id]
            # since=None: nothing is known about how long an output was off before the restart,
            # so min-off timers start clean; everything is off and nothing resumes on its own.
            st.on, st.since, st.mode, st.manual_on, st.manual_until = False, None, "AUTO", None, None
            if a.installed:
                changes.append(Change(a.id, False, "controller start — all outputs off", "boot"))
        self.irrigation_manual = None
        self._irr_by_auto = False
        return changes

    def tick(self, now: datetime) -> TickResult:
        res = TickResult()
        self._expire_manual(now, res)

        # 1–2  readings and zone aggregation
        eff = self.effective_readings(now)
        params = aggregate(self.reg, eff, PARAM_TYPES)
        res.params = params

        # 3  sensor health
        res.alerts.extend(self._health_alerts(now, eff, params))

        # 4  interlocks
        lock = self.lockouts(eff, params)
        res.lockouts = lock
        if lock.get("pump") == "LOW_WATER":
            res.alerts.append(AlertSignal("pump:low_water", "critical", "reservoir", "LOW_WATER",
                                          "Reservoir below minimum — all pump requests refused"))
        elif lock.get("pump") == "FLOAT_SWITCH_FAULT" and (now - self.started_at).total_seconds() > self._stale_after(self.cycle_s):
            res.alerts.append(AlertSignal("pump:float_fault", "high", "float_01", "FLOAT_SWITCH_FAULT",
                                          "Float switch reading unavailable — pump locked out (fail-safe)"))

        # 5  requests
        reqs = self._requests(now, params, lock)

        # 6  arbitration
        decisions, suppressed = arbitrate(reqs)
        res.suppressed = suppressed
        keys = {(s.actuator, s.source, s.by_source, s.wanted_on) for s in suppressed}
        res.new_suppressed = [s for s in suppressed if (s.actuator, s.source, s.by_source, s.wanted_on) not in self._last_suppressed]
        self._last_suppressed = keys

        # 7  physical targets → guard → changes
        targets = self._physical_targets(now, decisions, lock, res)
        self._apply(now, targets, res)

        # automatic fertigation (off by default until the EC sensor is installed)
        fert = self.cfg.get("fertigation", {})
        if fert.get("auto_enabled") and not self.dosing and "auger" not in lock:
            fr = fertigation_request(params.get("ec"), self.bands)
            min_gap = timedelta(hours=float(fert.get("min_interval_h", 6)))
            if fr and (self.last_dose_at is None or now - self.last_dose_at >= min_gap):
                ok, why = fertigation_gate(params.get("soil_moisture"), params.get("ec"), self.bands)
                if ok:
                    res.dose_request_g = float(fert.get("dose_g", 20))
                else:
                    s = Suppressed("auger", True, "ec", fr.rule, "fertigation_gate", 4, why or "gated")
                    res.suppressed.append(s)
        return res

    def _health_alerts(self, now: datetime, eff: dict[str, Reading], params: dict[str, ParamState]) -> list[AlertSignal]:
        out: list[AlertSignal] = []
        grace = (now - self.started_at).total_seconds() > self._stale_after(self.cycle_s)
        for sd in self.reg.sensors:
            if not sd.installed:
                continue
            r = eff.get(sd.id)
            if r is None:
                if grace:
                    out.append(AlertSignal(f"sensor:{sd.id}:stale", "medium", sd.id, "SENSOR_STALE",
                                           f"{sd.id}: no reading received"))
                continue
            if r.quality == "INVALID":
                out.append(AlertSignal(f"sensor:{sd.id}:invalid", "low", sd.id, "SENSOR_INVALID",
                                       f"{sd.id}: implausible or failed reading — excluded from the zone median"))
            elif r.quality == "STALE":
                out.append(AlertSignal(f"sensor:{sd.id}:stale", "medium", sd.id, "SENSOR_STALE",
                                       f"{sd.id}: no reading for {self.cfg.get('stale_after_cycles', 3)} cycles"))
            elif r.quality == "UNCALIBRATED":
                out.append(AlertSignal(f"sensor:{sd.id}:uncalibrated", "low", sd.id, "SENSOR_UNCALIBRATED",
                                       f"{sd.id}: needs calibration before it is used for control"))
        if not grace:   # just started: readings are still arriving, absence is not a fault yet
            return out
        for t, ps in params.items():
            for z in ps.manual_required_zones:
                out.append(AlertSignal(f"zone:{z}:{t}:manual_required", "high", f"zone_{z}", "ZONE_MANUAL_REQUIRED",
                                       f"Zone {z}: most {t.replace('_', ' ')} sensors faulted — automatic control "
                                       f"for this parameter suspended in the zone (MANUAL_REQUIRED)"))
        for node, online in self.node_online.items():
            if not online:
                out.append(AlertSignal(f"node:{node}:offline", "high", node, "NODE_OFFLINE",
                                       f"{node} offline — its sensors are STALE"))
        return out

    def _requests(self, now: datetime, params: dict[str, ParamState], lock: dict[str, str]) -> list[Request]:
        reqs: list[Request] = []
        pump = self.state.get("pump")
        irrigating = bool(pump and pump.on and self._irr_by_auto)

        # Irrigation (logical — expands to valve + main valve + pump)
        if "pump" in self.state and lock.get("pump") != "NOT_INSTALLED":
            soil = params.get("soil_moisture")
            band = self.bands.get("soil_moisture")
            r = irrigation_request(soil, band, irrigating, self.stage_circuit) if soil and band else None
            if r is None:
                r = Request("irrigation", False, RULE_THRESHOLD, "soil_moisture",
                            "no valid soil-moisture reading — automatic irrigation suspended")
            reqs.append(r)
            m = self.irrigation_manual
            if m:
                reqs.append(Request("irrigation", m["on"], RULE_CONTENTION, "manual",
                                    f"operator {m['by']} ({'ON' if m['on'] else 'OFF'})",
                                    circuit=m["circuit"], cmd_id=m["cmd"]))
            if lock.get("pump") in ("LOW_WATER", "FLOAT_SWITCH_FAULT"):
                reqs.append(Request("irrigation", False, RULE_SAFETY, "reservoir", f"pump interlock: {lock['pump']}"))

        # Ventilation
        fan = self.state.get("fan_exhaust")
        if fan is not None and "fan_exhaust" not in lock:
            reqs.extend(climate_requests(params, self.bands, fan.on))

        # Lighting
        lights = self.state.get("lights")
        if lights is not None and "lights" not in lock and "light" in params and "light" in self.bands:
            reqs.append(lighting_request(params["light"], self.bands["light"], self._in_photoperiod(now), lights.on))

        # Operator overrides on single actuators (fan, lights, diverter …) — contention level
        for aid, st in self.state.items():
            if aid in IRRIGATION_ACTS or st.mode != "MANUAL" or st.manual_on is None:
                continue
            reqs.append(Request(aid, st.manual_on, RULE_CONTENTION, "manual",
                                f"operator {st.manual_by} ({'ON' if st.manual_on else 'OFF'})", cmd_id=st.manual_cmd))
        return reqs

    def _in_photoperiod(self, now: datetime) -> bool:
        pp = self.cfg.get("photoperiod", {"start": "06:00", "end": "18:00"})
        t = local_time_of(now).strftime("%H:%M")
        return pp["start"] <= t < pp["end"]

    def _valves(self) -> dict[str, str]:
        return {a.circuit: a.id for a in self.reg.physical_actuators if a.circuit}

    def _physical_targets(self, now: datetime, decisions: dict[str, Request], lock: dict[str, str],
                          res: TickResult) -> dict[str, tuple[bool, str, str, bool, str | None]]:
        """Map decisions to physical actuators: {id: (on, reason, source, bypass_timers, cmd_id)}."""
        t: dict[str, tuple[bool, str, str, bool, str | None]] = {}

        def src(r: Request) -> str:
            return "safety" if r.rule == RULE_SAFETY else ("manual" if r.source == "manual" else "auto")

        d = decisions.get("irrigation")
        valves = self._valves()
        if d is not None:
            circuit = d.circuit or self.stage_circuit
            s, bypass = src(d), d.rule == RULE_SAFETY
            on = d.on and circuit in valves and valves[circuit] not in lock
            for c, vid in valves.items():
                t[vid] = (on and c == circuit, d.reason, s, bypass, d.cmd_id)
            if "servo_main" in self.state:
                t["servo_main"] = (on, d.reason, s, bypass, d.cmd_id)
            t["pump"] = (on, d.reason, s, bypass, d.cmd_id)

        # Direct operator commands on single irrigation parts override the logical decision for that part.
        for aid in IRRIGATION_ACTS:
            st = self.state.get(aid)
            if st and st.mode == "MANUAL" and st.manual_on is not None:
                t[aid] = (st.manual_on, f"operator {st.manual_by}", "manual", False, st.manual_cmd)

        for aid, r in decisions.items():
            if aid != "irrigation" and aid in self.state:
                t[aid] = (r.on, r.reason, src(r), r.rule == RULE_SAFETY, r.cmd_id)

        # Safety: the pump never runs locked out, and never against closed valves (deadhead).
        if "pump" in t:
            on, reason, s, bypass, cmd = t["pump"]
            if on and lock.get("pump"):
                t["pump"] = (False, f"pump interlock: {lock['pump']}", "safety", True, cmd)
            elif on and not any(t.get(v, (self.state[v].on,))[0] for v in valves.values() if v in self.state):
                t["pump"] = (False, "no irrigation valve open", "safety", True, cmd)
        # Maximum continuous run (flood protection)
        for a in self.reg.physical_actuators:
            st = self.state[a.id]
            if a.max_run_s and st.on and st.running_for(now) >= a.max_run_s:
                t[a.id] = (False, f"maximum continuous run {a.max_run_s // 60} min reached", "safety", True, None)
                G.start_cooldown(st, now, max(a.min_off_s, 600))
                res.alerts.append(AlertSignal(f"{a.id}:max_run:{now.isoformat()}", "high", a.id, "MAX_RUN_EXCEEDED",
                                              f"{a.name} forced off after {a.max_run_s // 60} min; cooldown enforced",
                                              kind="event"))
                if a.id == "pump" and self.irrigation_manual:
                    self.irrigation_manual = None
                    res.mode_changes.append(("irrigation", "AUTO", "manual irrigation ended by max-run protection"))
                if st.mode == "MANUAL":
                    st.mode, st.manual_on, st.manual_until = "AUTO", None, None
        # Not installed → never touched
        for aid in list(t):
            if lock.get(aid) == "NOT_INSTALLED":
                del t[aid]
        return t

    def _apply(self, now: datetime, targets: dict, res: TickResult) -> None:
        # Pump start is the gate for the whole irrigation group: if the pump may not start yet,
        # valves that were about to open stay closed too (deferred, retried next cycle).
        pump_blocked = False
        if "pump" in targets and targets["pump"][0] and not self.state["pump"].on:
            ok, why, retry = G.check(self.reg.actuator("pump"), self.state["pump"], True, now, targets["pump"][3])
            if not ok:
                pump_blocked = True
                res.deferred.append(Deferred("pump", True, why or "", retry))

        offs, ons = [], []
        for aid, (on, reason, source, bypass, cmd) in targets.items():
            st = self.state[aid]
            if on == st.on:
                continue
            if pump_blocked and on and aid in IRRIGATION_ACTS:
                if aid != "pump":
                    res.deferred.append(Deferred(aid, True, "waiting for pump", 0))
                continue
            ok, why, retry = G.check(self.reg.actuator(aid), st, on, now, bypass)
            if not ok:
                res.deferred.append(Deferred(aid, on, why or "", retry))
                continue
            (ons if on else offs).append(Change(aid, on, reason, source, cmd))

        # Order: pump off first, then everything else off; valves on before the pump starts.
        offs.sort(key=lambda c: 0 if c.actuator == "pump" else 1)
        ons.sort(key=lambda c: 1 if c.actuator == "pump" else 0)
        for c in offs + ons:
            G.set_state(self.state[c.actuator], c.on, now, c.reason)
            res.changes.append(c)
            if c.actuator == "pump":
                self._irr_by_auto = c.on and c.source == "auto"

    # ── operator commands ────────────────────────────────────────────────
    def command(self, cmd: CommandIn, now: datetime) -> CommandResult:
        if cmd.cmd_id in self._seen:
            return self._seen[cmd.cmd_id]
        result = self._command(cmd, now)
        self._seen[cmd.cmd_id] = result
        while len(self._seen) > 500:
            self._seen.popitem(last=False)
        return result

    def _command(self, cmd: CommandIn, now: datetime) -> CommandResult:
        expiry = float(self.cfg.get("command_expiry_s", 60))
        age = (now - cmd.issued_at).total_seconds()
        if age > expiry:
            return CommandResult("EXPIRED", "EXPIRED", f"command is {age:.0f} s old (limit {expiry:.0f} s)")
        aid = cmd.actuator_id
        if not self.reg.has_actuator(aid):
            return CommandResult("REJECTED", "UNKNOWN_ACTUATOR", f"no actuator '{aid}'")
        adef = self.reg.actuator(aid)
        eff = self.effective_readings(now)
        params = aggregate(self.reg, eff, PARAM_TYPES)
        lock = self.lockouts(eff, params)
        if not adef.virtual and lock.get(aid) == "NOT_INSTALLED":
            return CommandResult("REJECTED", "NOT_INSTALLED", f"{adef.name} is not installed")

        if cmd.action == "AUTO":
            if aid == "irrigation":
                self.irrigation_manual = None
            else:
                st = self.state[aid]
                st.mode, st.manual_on, st.manual_until, st.manual_cmd = "AUTO", None, None, None
            return CommandResult("ACCEPTED", None, f"{adef.name} returned to automatic control")

        if cmd.action == "DOSE":
            if aid != "auger":
                return CommandResult("REJECTED", "BAD_ACTION", "DOSE applies to the auger only")
            g = cmd.target_g or 0
            if not 0 < g <= 500:
                return CommandResult("REJECTED", "BAD_TARGET", "target must be between 0 and 500 g")
            if self.dosing:
                return CommandResult("REJECTED", "DOSING", "a dose is already in progress")
            ok, why = fertigation_gate(params.get("soil_moisture"), params.get("ec"), self.bands)
            if not ok:
                reason, _, msg = (why or "FERTIGATION_GATED").partition(": ")
                return CommandResult("REJECTED", reason, msg or why)
            self.dosing = True
            self.dose_stop_requested = False
            return CommandResult("ACCEPTED", None, f"dosing {g:g} g", dose_g=g)

        if cmd.action not in ("ON", "OFF"):
            return CommandResult("REJECTED", "BAD_ACTION", f"unknown action {cmd.action}")
        if aid == "auger" and cmd.action == "OFF" and self.dosing:
            self.dose_stop_requested = True
            return CommandResult("ACCEPTED", None, "stopping the dose")
        on = cmd.action == "ON"
        cap = self._manual_cap(adef.water)
        duration = min(float(cmd.duration_s or cap), cap)
        until = now + timedelta(seconds=duration)

        if aid == "irrigation":
            circuit = cmd.circuit or self.stage_circuit
            valves = self._valves()
            if on:
                if circuit not in valves:
                    return CommandResult("REJECTED", "UNKNOWN_CIRCUIT", f"no valve for circuit '{circuit}'")
                if lock.get(valves[circuit]) == "NOT_INSTALLED":
                    return CommandResult("REJECTED", "NOT_INSTALLED", f"{circuit} valve not installed")
                if lock.get("pump"):
                    return CommandResult("REJECTED", lock["pump"], f"pump interlock: {lock['pump']}")
                ok, why, retry = G.check(self.reg.actuator("pump"), self.state["pump"], True, now)
                if not ok:
                    return CommandResult("REJECTED", why, f"pump available again in {retry:.0f} s")
            self.irrigation_manual = {"on": on, "circuit": circuit, "until": until, "cmd": cmd.cmd_id, "by": cmd.issued_by}
            return CommandResult("ACCEPTED", None,
                                 f"irrigation {'ON' if on else 'OFF'} ({circuit}) for {duration / 60:.0f} min")

        st = self.state[aid]
        if on and aid == "pump":
            if lock.get("pump"):
                return CommandResult("REJECTED", lock["pump"], f"pump interlock: {lock['pump']}")
            if not any(self.state[v].on for v in self._valves().values() if v in self.state):
                return CommandResult("REJECTED", "NO_OPEN_VALVE", "open an irrigation valve before starting the pump")
        if on and adef.circuit:
            other = [v for c, v in self._valves().items() if c != adef.circuit and v in self.state and self.state[v].on]
            if other:
                return CommandResult("REJECTED", "PUMP_BUSY", f"{other[0]} is open — one irrigation circuit at a time")
        ok, why, retry = G.check(adef, st, on, now)
        if not ok:
            return CommandResult("REJECTED", why, f"retry in {retry:.0f} s" if retry else None)
        st.mode, st.manual_on, st.manual_until, st.manual_cmd, st.manual_by = "MANUAL", on, until, cmd.cmd_id, cmd.issued_by
        return CommandResult("ACCEPTED", None, f"{adef.name} {'ON' if on else 'OFF'} for {duration / 60:.0f} min (manual)")

    def estop(self, now: datetime, by: str) -> list[Change]:
        """Emergency stop: everything off now (timers bypassed) and held off manually for 30 min,
        or until each actuator is returned to AUTO."""
        until = now + timedelta(seconds=self._manual_cap(True))
        if self.dosing:
            self.dose_stop_requested = True
        self.irrigation_manual = {"on": False, "circuit": self.stage_circuit, "until": until, "cmd": None, "by": by}
        changes: list[Change] = []
        order = sorted(self.state, key=lambda a: 0 if a == "pump" else 1)
        for aid in order:
            st = self.state[aid]
            st.mode, st.manual_on, st.manual_until, st.manual_cmd, st.manual_by = "MANUAL", False, until, None, by
            if st.on:
                G.set_state(st, False, now, f"emergency stop by {by}")
                changes.append(Change(aid, False, f"emergency stop by {by}", "safety"))
        return changes

    def dose_finished(self, now: datetime) -> None:
        self.dosing = False
        self.dose_stop_requested = False
        self.last_dose_at = now

    # ── views ────────────────────────────────────────────────────────────
    def actuator_view(self, aid: str, lock: dict[str, str] | None = None) -> dict[str, Any]:
        st = self.state[aid]
        a = self.reg.actuator(aid)
        mode = st.mode
        if aid in IRRIGATION_ACTS and self.irrigation_manual and mode == "AUTO":
            mode = "MANUAL"
        return {"actuator_id": aid, "on": st.on, "mode": mode, "installed": a.installed,
                "manual_until": st.manual_until, "since": st.since, "reason": st.reason,
                "lockout": (lock or {}).get(aid)}

    def irrigation_view(self) -> dict[str, Any]:
        pump = self.state.get("pump")
        valves = self._valves()
        circuit = next((c for c, v in valves.items() if v in self.state and self.state[v].on), None)
        m = self.irrigation_manual
        return {"actuator_id": "irrigation", "on": bool(pump and pump.on), "circuit": circuit,
                "mode": "MANUAL" if m else "AUTO", "manual_until": m["until"] if m else None,
                "stage_circuit": self.stage_circuit}
