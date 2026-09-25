"""Loads contract/registry.yaml into typed objects and validates it."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

PARAMS = ("soil_moisture", "temperature", "humidity", "light", "co2", "ph", "ec")


@dataclass(frozen=True)
class Zone:
    id: int
    name: str
    description: str = ""


@dataclass(frozen=True)
class Node:
    id: str
    board: str
    zone: int
    publish_interval_s: int = 30


@dataclass(frozen=True)
class Stage:
    id: str
    name: str
    sequence: int
    irrigation_mode: str
    description: str = ""


@dataclass(frozen=True)
class SensorDef:
    id: str
    type: str
    zone: int
    host: str
    unit: str
    plausible: tuple[float, float] | None
    installed: bool = True
    calibration: str = "none"
    interval_s: int = 30
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def on_node(self) -> bool:
        return self.host != "pi"


@dataclass(frozen=True)
class ActuatorDef:
    id: str
    name: str
    kind: str
    group: str
    installed: bool = True
    water: bool = False
    min_on_s: int = 0
    min_off_s: int = 0
    max_run_s: int | None = None
    daily_cap_s: int | None = None
    manual_only: bool = False
    circuit: str | None = None
    virtual: bool = False
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class Registry:
    raw: dict[str, Any]
    greenhouse_id: str
    greenhouse_name: str
    timezone: str
    capabilities: dict[str, bool]
    zones: list[Zone]
    nodes: list[Node]
    stages: list[Stage]
    default_thresholds: dict[str, dict[str, tuple[float, float]]]
    deadbands: dict[str, float]
    control: dict[str, Any]
    sensors: list[SensorDef]
    actuators: list[ActuatorDef]
    relay_board: dict[str, Any]

    # lookups
    def sensor(self, sid: str) -> SensorDef:
        return self._sensors[sid]

    def actuator(self, aid: str) -> ActuatorDef:
        return self._actuators[aid]

    def has_actuator(self, aid: str) -> bool:
        return aid in self._actuators

    def has_sensor(self, sid: str) -> bool:
        return sid in self._sensors

    def stage(self, stage_id: str) -> Stage:
        for s in self.stages:
            if s.id == stage_id:
                return s
        raise KeyError(stage_id)

    def sensors_of(self, type_: str, zone: int | None = None, installed_only: bool = True) -> list[SensorDef]:
        return [s for s in self.sensors if s.type == type_ and (zone is None or s.zone == zone)
                and (s.installed or not installed_only)]

    def node_sensors(self, node_id: str) -> list[SensorDef]:
        return [s for s in self.sensors if s.host == node_id]

    @property
    def physical_actuators(self) -> list[ActuatorDef]:
        return [a for a in self.actuators if not a.virtual]

    def __post_init__(self) -> None:
        self._sensors = {s.id: s for s in self.sensors}
        self._actuators = {a.id: a for a in self.actuators}


_SENSOR_KEYS = {"id", "type", "zone", "host", "installed", "calibration", "interval_s", "unit"}
_ACT_KEYS = {"id", "name", "kind", "group", "installed", "water", "min_on_s", "min_off_s", "max_run_s",
             "daily_cap_s", "manual_only", "circuit"}


def load_registry(path: Path | str) -> Registry:
    data = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    return parse_registry(data)


def parse_registry(data: dict[str, Any]) -> Registry:
    gh = data["greenhouse"]
    defaults = data.get("sensor_defaults", {})
    plaus = defaults.get("plausible", {})
    units = defaults.get("units", {})

    sensors = []
    for s in data["sensors"]:
        t = s["type"]
        p = plaus.get(t)
        sensors.append(SensorDef(
            id=s["id"], type=t, zone=int(s["zone"]), host=s["host"],
            unit=s.get("unit", units.get(t, "")),
            plausible=(float(p[0]), float(p[1])) if p else None,
            installed=bool(s.get("installed", True)),
            calibration=s.get("calibration", "none"),
            interval_s=int(s.get("interval_s", 30)),
            extra={k: v for k, v in s.items() if k not in _SENSOR_KEYS},
        ))

    actuators = []
    for a in data["actuators"]:
        actuators.append(ActuatorDef(
            id=a["id"], name=a["name"], kind=a["kind"], group=a["group"],
            installed=bool(a.get("installed", True)), water=bool(a.get("water", False)),
            min_on_s=int(a.get("min_on_s", 0)), min_off_s=int(a.get("min_off_s", 0)),
            max_run_s=a.get("max_run_s"), daily_cap_s=a.get("daily_cap_s"),
            manual_only=bool(a.get("manual_only", False)), circuit=a.get("circuit"),
            extra={k: v for k, v in a.items() if k not in _ACT_KEYS},
        ))
    for v in data.get("virtual_actuators", []):
        actuators.append(ActuatorDef(
            id=v["id"], name=v["name"], kind="virtual", group=v["group"], water=bool(v.get("water", False)),
            virtual=True, extra={"expands_to": v.get("expands_to", [])},
        ))

    thr = data["thresholds"]
    stages = [Stage(**st) for st in data["growth_stages"]]
    default_thresholds: dict[str, dict[str, tuple[float, float]]] = {}
    for st in stages:
        default_thresholds[st.id] = {p: (float(v["min"]), float(v["max"])) for p, v in thr[st.id].items()}

    reg = Registry(
        raw=data,
        greenhouse_id=gh["id"], greenhouse_name=gh["name"], timezone=gh.get("timezone", "Asia/Manila"),
        capabilities={k: bool(v) for k, v in data.get("capabilities", {}).items()},
        zones=[Zone(**z) for z in data["zones"]],
        nodes=[Node(**n) for n in data.get("nodes", [])],
        stages=stages,
        default_thresholds=default_thresholds,
        deadbands={k: float(v) for k, v in thr.get("deadbands", {}).items()},
        control=data.get("control", {}),
        sensors=sensors,
        actuators=actuators,
        relay_board=data.get("relay_board", {}),
    )
    validate_registry(reg)
    return reg


class RegistryError(ValueError):
    pass


def validate_registry(reg: Registry) -> None:
    errors: list[str] = []
    ids = [s.id for s in reg.sensors]
    if len(ids) != len(set(ids)):
        errors.append("duplicate sensor ids")
    aids = [a.id for a in reg.actuators]
    if len(aids) != len(set(aids)):
        errors.append("duplicate actuator ids")
    zone_ids = {z.id for z in reg.zones}
    node_ids = {n.id for n in reg.nodes}
    for s in reg.sensors:
        if s.zone not in zone_ids:
            errors.append(f"sensor {s.id}: unknown zone {s.zone}")
        if s.host != "pi" and s.host not in node_ids:
            errors.append(f"sensor {s.id}: unknown host {s.host}")
    for st in reg.stages:
        missing = [p for p in PARAMS if p not in reg.default_thresholds.get(st.id, {})]
        if missing:
            errors.append(f"stage {st.id}: missing thresholds {missing}")
        for p, (lo, hi) in reg.default_thresholds.get(st.id, {}).items():
            if lo >= hi:
                errors.append(f"stage {st.id} {p}: min >= max")
        if not reg.has_actuator(f"valve_{st.irrigation_mode}"):
            errors.append(f"stage {st.id}: no valve_{st.irrigation_mode}")
    # Relay channels must not be shared between actuators.
    used: dict[str, str] = {}
    for a in reg.physical_actuators:
        chans = [a.extra.get("channel")] + list(a.extra.get("also", []) or [])
        for ch in filter(None, chans):
            if ch in used:
                errors.append(f"relay channel {ch} used by {used[ch]} and {a.id}")
            used[ch] = a.id
    if errors:
        raise RegistryError("; ".join(errors))
