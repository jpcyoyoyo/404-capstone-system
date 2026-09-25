from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

QUALITY_VALID = "VALID"


@dataclass
class Reading:
    sensor_id: str
    type: str
    zone: int
    value: float | None
    quality: str
    ts: datetime

    @property
    def valid(self) -> bool:
        return self.quality == QUALITY_VALID and self.value is not None


@dataclass(frozen=True)
class Band:
    lo: float
    hi: float
    deadband: float = 0.0

    @property
    def setpoint(self) -> float:
        return (self.lo + self.hi) / 2.0


# Arbitration precedence (Integration Plan §3.5). Lower number wins.
RULE_SAFETY = 1
RULE_CONTENTION = 2   # includes operator (manual) commands, merged here per the process-flow figure
RULE_COUPLING = 3
RULE_GATING = 4
RULE_THRESHOLD = 5

RULE_NAMES = {1: "safety", 2: "contention", 3: "coupling", 4: "gating", 5: "threshold"}


@dataclass
class Request:
    actuator: str          # physical actuator id, or "irrigation"
    on: bool
    rule: int
    source: str            # e.g. "temperature", "manual", "float_switch"
    reason: str
    rank: int = 0          # tie-break within a rule (coupling order); lower wins
    circuit: str | None = None
    cmd_id: str | None = None


@dataclass
class Change:
    actuator: str
    on: bool
    reason: str
    source: str            # auto | manual | safety | boot
    cmd_id: str | None = None


@dataclass
class AlertSignal:
    key: str
    severity: str          # low | medium | high | critical
    source: str
    code: str
    message: str
    kind: str = "condition"  # condition (auto-resolves when it clears) | event (one-shot)


@dataclass
class Suppressed:
    actuator: str
    wanted_on: bool
    source: str
    rule: int
    by_source: str
    by_rule: int
    reason: str


@dataclass
class ZoneValue:
    zone: int
    median: float | None
    n_valid: int
    n_total: int
    n_warming: int = 0

    @property
    def faulted(self) -> bool:
        # "Majority of a zone faulted" (§3.6). With one sensor, that one being bad is a majority.
        # A sensor still warming up (CO₂, first 3 min) is not a fault — it is just not usable yet.
        return self.n_total > 0 and (self.n_total - self.n_valid - self.n_warming) * 2 > self.n_total


@dataclass
class ParamState:
    type: str
    zones: dict[int, ZoneValue] = field(default_factory=dict)
    value: float | None = None       # median of healthy zone medians
    manual_required_zones: list[int] = field(default_factory=list)

    @property
    def available(self) -> bool:
        return self.value is not None
