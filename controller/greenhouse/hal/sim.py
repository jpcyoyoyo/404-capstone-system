"""Simulated greenhouse: physics good enough to exercise every control path without hardware.

Used by `greenhouse dev`, by `greenhouse sim-nodes` (fake Node A/B), and in tests.
Supports fault injection so the Gate 2 fault list and the Level 3 test cases can be
demonstrated live: force a sensor value, make it fail, make it go silent, take a node
offline, drain the reservoir, jam the auger.
"""
from __future__ import annotations

import math
import random
import threading
import time
from datetime import datetime
from typing import Callable

from ..registry import ActuatorDef, Registry, SensorDef
from ..timeutil import local_time_of, utcnow
from . import DoseResult, Hal, RawSample

# Converter counts for the simulated capacitive probes (higher = drier), per sensor index.
SOIL_DRY = [26100, 25800, 26400, 25900, 26250, 25700]
SOIL_WET = [12100, 12500, 11900, 12300, 12050, 12400]
PH_SLOPE, PH_INTERCEPT = -5.70, 21.25          # module volts → pH (7.0 at 2.5 V)
HX_OFFSET, HX_SCALE = 8000.0, 420.0            # HX711 counts → grams


def sim_calibrations(reg: Registry) -> dict[str, dict]:
    """Calibration constants that match the simulator (seeded by `greenhouse init-db --sim`)."""
    out: dict[str, dict] = {}
    soil = [s for s in reg.sensors if s.type == "soil_moisture"]
    for i, s in enumerate(soil):
        out[s.id] = {"dry": SOIL_DRY[i % 6], "wet": SOIL_WET[i % 6]}
    for s in reg.sensors:
        if s.type == "ph":
            out[s.id] = {"slope": PH_SLOPE, "intercept": PH_INTERCEPT, "kind": "ph"}
        elif s.type == "ec":
            out[s.id] = {"slope": 1.0, "intercept": 0.0, "kind": "ec"}
        elif s.type == "hopper_weight":
            out[s.id] = {"offset": HX_OFFSET, "scale": HX_SCALE}
    return out


class Environment:
    def __init__(self, reg: Registry, seed: int | None = None):
        self.reg = reg
        self.rng = random.Random(seed)
        self.lock = threading.RLock()
        self.t = utcnow()
        self.temp, self.hum, self.co2 = 27.0, 72.0, 620.0
        soil_ids = [s.id for s in reg.sensors if s.type == "soil_moisture"]
        self.soil = {sid: 64.0 + self.rng.uniform(-3, 3) for sid in soil_ids}
        self.soil_index = {sid: i for i, sid in enumerate(soil_ids)}
        self.ph, self.ec, self.wtemp = 6.1, 1.4, 26.0
        self.level_pct, self.hopper_g = 85.0, 900.0
        self.flow_lpm = 0.0
        self.act: dict[str, bool] = {}
        # faults
        self.forced: dict[str, float | None] = {}   # sensor_id → forced ENGINEERING value (None = failed read)
        self.silent: set[str] = set()                # sensors that stop reporting
        self.offline_nodes: set[str] = set()
        self.auger_jammed = False

    # ── actuators ────────────────────────────────────────────────────────
    def set_actuator(self, aid: str, on: bool) -> None:
        with self.lock:
            self.act[aid] = on

    def _on(self, aid: str) -> bool:
        return self.act.get(aid, False)

    # ── physics ──────────────────────────────────────────────────────────
    def sun_lux(self, now: datetime) -> float:
        h = local_time_of(now)
        hour = h.hour + h.minute / 60
        if hour < 6 or hour > 18:
            return 0.0
        return max(0.0, 32000 * math.sin(math.pi * (hour - 6) / 12)) * self.rng.uniform(0.85, 1.0)

    def step(self, now: datetime | None = None) -> None:
        with self.lock:
            now = now or utcnow()
            dt = max(0.0, min(300.0, (now - self.t).total_seconds()))
            self.t = now
            k = dt / 60.0  # per-minute rates
            sun = self.sun_lux(now)
            # temperature: drifts toward a solar-driven target; the fan pulls it down
            target_t = 24 + sun / 3200 - (3.5 if self._on("fan_exhaust") else 0)
            self.temp += (target_t - self.temp) * 0.04 * k + self.rng.gauss(0, 0.05)
            target_h = 78 - sun / 1600 - (12 if self._on("fan_exhaust") else 0) + (8 if self._on("valve_fog") and self._on("pump") else 0)
            self.hum += (target_h - self.hum) * 0.05 * k + self.rng.gauss(0, 0.2)
            target_c = 420 if self._on("fan_exhaust") else (380 if sun > 5000 else 700)
            self.co2 += (target_c - self.co2) * 0.05 * k + self.rng.gauss(0, 4)
            irrigating = self._on("pump") and any(self._on(v) for v in ("valve_fog", "valve_drip", "valve_sprinkler"))
            rate = 1.2 if irrigating else -0.03 - sun / 1_000_000
            for sid in self.soil:
                self.soil[sid] = max(5.0, min(98.0, self.soil[sid] + rate * k + self.rng.gauss(0, 0.05)))
            self.flow_lpm = (6.0 + self.rng.gauss(0, 0.2)) if irrigating else 0.0
            if irrigating:
                self.level_pct = max(0.0, self.level_pct - 0.35 * k)
            self.ph += (6.1 - self.ph) * 0.01 * k + self.rng.gauss(0, 0.005)
            self.ec += (1.3 - self.ec) * 0.002 * k + self.rng.gauss(0, 0.003)
            self.wtemp += (25.5 + sun / 20000 - self.wtemp) * 0.02 * k
            self.hum = max(20.0, min(99.0, self.hum))

    def light_at(self, zone: int, now: datetime) -> float:
        return self.sun_lux(now) * (1.0 if zone == 1 else 0.92) + (1800 if self._on("lights") else 0)

    # ── what each sensor would report ────────────────────────────────────
    def engineering(self, sd: SensorDef, now: datetime) -> float:
        t = sd.type
        if t == "temperature":
            return self.temp + (0.3 if sd.zone == 2 else 0) + self.rng.gauss(0, 0.1)
        if t == "humidity":
            return self.hum + (-1.0 if sd.zone == 2 else 0) + self.rng.gauss(0, 0.5)
        if t == "soil_moisture":
            return self.soil[sd.id]
        if t == "light":
            return self.light_at(sd.zone, now)
        if t == "co2":
            return self.co2
        if t == "ph":
            return self.ph
        if t == "ec":
            return self.ec
        if t == "water_temperature":
            return self.wtemp + self.rng.gauss(0, 0.05)
        if t == "water_level":
            return self.level_pct
        if t == "water_flow":
            return self.flow_lpm
        if t == "hopper_weight":
            return self.hopper_g
        if t == "float_switch":
            return 1.0 if self.level_pct > 12 else 0.0
        return 0.0

    def to_raw(self, sd: SensorDef, value: float) -> float:
        if sd.type == "soil_moisture":
            i = self.soil_index[sd.id] % 6
            return round(SOIL_DRY[i] - value / 100.0 * (SOIL_DRY[i] - SOIL_WET[i]) + self.rng.gauss(0, 40))
        if sd.type == "ph":
            module_v = (value - PH_INTERCEPT) / PH_SLOPE
            return round(module_v / float(sd.extra.get("divider", 1.0)), 4)
        if sd.type == "hopper_weight":
            return round(value * HX_SCALE + HX_OFFSET + self.rng.gauss(0, 60))
        return round(value, 2)

    def sample(self, sd: SensorDef, now: datetime | None = None) -> RawSample | None:
        """None means the sensor produced nothing this cycle (silent / node offline)."""
        now = now or utcnow()
        with self.lock:
            if sd.id in self.silent or (sd.on_node and sd.host in self.offline_nodes):
                return None
            if sd.id in self.forced:
                v = self.forced[sd.id]
                if v is None:
                    return RawSample(sd.id, None, False, "forced failure")
                if sd.type == "soil_moisture" and v == 0:
                    return RawSample(sd.id, 0.0, True)      # a shorted probe: raw 0, far outside its span
                return RawSample(sd.id, self.to_raw(sd, v), True)
            return RawSample(sd.id, self.to_raw(sd, self.engineering(sd, now)), True)

    # ── fault injection ──────────────────────────────────────────────────
    def apply_fault(self, fault: dict) -> str:
        kind = fault.get("kind")
        sid, node = fault.get("sensor_id"), fault.get("node_id")
        with self.lock:
            if kind == "force":
                self.forced[sid] = fault.get("value")
            elif kind == "fail":
                self.forced[sid] = None
            elif kind == "silence":
                self.silent.add(sid)
            elif kind == "node_offline":
                self.offline_nodes.add(node)
            elif kind == "node_online":
                self.offline_nodes.discard(node)
            elif kind == "drain":
                self.level_pct = float(fault.get("value", 5))
            elif kind == "fill":
                self.level_pct = float(fault.get("value", 90))
            elif kind == "jam_auger":
                self.auger_jammed = bool(fault.get("value", True))
            elif kind == "set":
                attr = fault.get("attr")
                if attr in ("temp", "hum", "co2", "ph", "ec"):
                    setattr(self, attr, float(fault["value"]))
                elif attr == "soil":
                    for k in self.soil:
                        self.soil[k] = float(fault["value"])
                else:
                    return f"unknown attr {attr}"
            elif kind == "clear":
                if sid:
                    self.forced.pop(sid, None)
                    self.silent.discard(sid)
                else:
                    self.forced.clear()
                    self.silent.clear()
                    self.offline_nodes.clear()
                    self.auger_jammed = False
            else:
                return f"unknown fault kind {kind}"
        return "ok"


class SimHal(Hal):
    def __init__(self, reg: Registry, env: Environment):
        self.reg, self.env = reg, env
        self.outputs: dict[str, bool] = {}

    def set_output(self, adef: ActuatorDef, on: bool) -> None:
        self.outputs[adef.id] = on
        self.env.set_actuator(adef.id, on)

    def servo_pulse(self, channel: int, pulse_us: float) -> None:
        self.outputs[f"pca9685:{channel}"] = pulse_us > 0

    def jog(self, steps: int, reverse: bool = False, step_delay_s: float = 0.001) -> None:
        with self.env.lock:
            if not reverse:
                self.env.hopper_g = max(0.0, self.env.hopper_g - steps / 200 * 5.0)   # ~5 g per revolution

    def ultrasonic_distance_cm(self, sd: SensorDef) -> float | None:
        depth, blind = float(sd.extra.get("tank_depth_cm", 60)), float(sd.extra.get("blind_zone_cm", 25))
        return round(depth - self.env.level_pct / 100.0 * (depth - blind), 1)

    def read_local(self, sensors: list[SensorDef]) -> list[RawSample]:
        self.env.step()
        now = utcnow()
        out = []
        for sd in sensors:
            s = self.env.sample(sd, now)
            if s is not None:
                out.append(s)
        return out

    def dose(self, target_g: float, tolerance_g: float, max_time_s: float,
             interlocks_clear: Callable[[], bool]) -> DoseResult:
        """Same closed loop as the real auger (Integration Plan §4.3), against the simulated load cell."""
        start_mass = self.env.hopper_g
        t0 = time.monotonic()
        delivered = 0.0
        while delivered < target_g - tolerance_g:
            if not interlocks_clear():
                return DoseResult(delivered, "aborted", "INTERLOCK")
            if time.monotonic() - t0 > max_time_s:
                return DoseResult(delivered, "aborted", "AUGER_JAM")
            if not self.env.auger_jammed:
                with self.env.lock:
                    step = min(self.env.hopper_g, self.env.rng.uniform(1.5, 3.0))
                    self.env.hopper_g -= step
                    self.env.ec += step * 0.002
            time.sleep(0.05)
            delivered = start_mass - self.env.hopper_g
        return DoseResult(round(delivered, 1), "complete", "")
