from __future__ import annotations

import copy
from datetime import datetime, timedelta
from pathlib import Path

import pytest
import yaml

from greenhouse.control.engine import ControlEngine
from greenhouse.control.types import Reading
from greenhouse.registry import parse_registry

REGISTRY = Path(__file__).resolve().parents[2] / "contract" / "registry.yaml"
T0 = datetime(2026, 10, 13, 2, 0, 0)  # 10:00 Asia/Manila — inside the photoperiod


@pytest.fixture
def raw_registry() -> dict:
    return yaml.safe_load(REGISTRY.read_text(encoding="utf-8"))


def make_registry(raw: dict, install_all: bool = True):
    data = copy.deepcopy(raw)
    if install_all:
        for s in data["sensors"]:
            s["installed"] = True
        for a in data["actuators"]:
            a["installed"] = True
    return parse_registry(data)


@pytest.fixture
def reg(raw_registry):
    return make_registry(raw_registry)


# Comfortable mid-band values for the "growth" stage.
NORMAL = {
    "soil_moisture": 67.0, "temperature": 25.0, "humidity": 70.0, "light": 20000.0,
    "co2": 600.0, "ph": 6.0, "ec": 1.5, "water_temperature": 25.0, "water_level": 80.0,
    "water_flow": 0.0, "hopper_weight": 800.0, "float_switch": 1.0,
}


class Feeder:
    def __init__(self, engine: ControlEngine, reg):
        self.e, self.reg = engine, reg

    def all(self, now: datetime, **overrides: float) -> None:
        vals = {**NORMAL, **overrides}
        for sd in self.reg.sensors:
            if sd.type in vals:
                self.e.update_reading(Reading(sd.id, sd.type, sd.zone, vals[sd.type], "VALID", now))

    def one(self, sid: str, value: float | None, now: datetime, quality: str = "VALID") -> None:
        sd = self.reg.sensor(sid)
        self.e.update_reading(Reading(sid, sd.type, sd.zone, value, quality, now))


@pytest.fixture
def engine(reg):
    e = ControlEngine(reg, T0 - timedelta(hours=1))
    e.set_stage("growth")
    e.boot(T0 - timedelta(hours=1))
    return e


@pytest.fixture
def feed(engine, reg):
    return Feeder(engine, reg)
