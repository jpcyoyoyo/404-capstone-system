"""Hardware abstraction: the control and sensor services talk to this, never to GPIO directly."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from ..registry import ActuatorDef, Registry, SensorDef


@dataclass
class RawSample:
    sensor_id: str
    raw: float | None
    ok: bool
    error: str | None = None


@dataclass
class DoseResult:
    delivered_g: float
    status: str      # complete | aborted
    reason: str      # "" | AUGER_JAM | INTERLOCK | ...


class Hal:
    def set_output(self, adef: ActuatorDef, on: bool) -> None:
        raise NotImplementedError

    def read_local(self, sensors: list[SensorDef]) -> list[RawSample]:
        raise NotImplementedError

    def dose(self, target_g: float, tolerance_g: float, max_time_s: float,
             interlocks_clear: Callable[[], bool]) -> DoseResult:
        raise NotImplementedError

    def close(self) -> None:
        pass


def make_hal(kind: str, reg: Registry, env=None) -> Hal:
    if kind == "sim":
        from .sim import SimHal, Environment
        return SimHal(reg, env or Environment(reg))
    if kind == "pi":
        from .pi import PiHal
        return PiHal(reg)
    raise ValueError(f"unknown HAL '{kind}' (use sim or pi)")
