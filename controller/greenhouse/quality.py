"""Quality flags (Integration Plan §1.1, §8.3): every stored reading carries its provenance.

A failed read is never stored as zero — it is stored with value None and quality INVALID.
"""
from __future__ import annotations

from datetime import datetime

from . import calibration as cal
from .registry import SensorDef


def evaluate(sd: SensorDef, raw: float | None, ok: bool, constants: dict | None, now: datetime,
             started_at: datetime, *, warmup_s: float = 180, water_temp_c: float | None = None
             ) -> tuple[float | None, str]:
    if not ok or raw is None:
        return None, "INVALID"
    if sd.type == "float_switch":
        return (1.0 if raw >= 0.5 else 0.0), "VALID"
    if sd.calibration == "dry_wet" and constants:
        lo, hi = sorted((float(constants["dry"]), float(constants["wet"])))
        # A disconnected or shorted probe reads far outside its own dry/wet span.
        span = hi - lo
        if raw < lo - 0.25 * span or raw > hi + 0.25 * span:
            return None, "INVALID"
    try:
        value = cal.apply(sd.calibration, float(raw), constants, extra=sd.extra, water_temp_c=water_temp_c)
    except cal.NeedsCalibration:
        return None, "UNCALIBRATED"
    if sd.plausible and not (sd.plausible[0] <= value <= sd.plausible[1]):
        return None, "INVALID"
    if sd.type == "co2" and (now - started_at).total_seconds() < warmup_s:
        return round(value, 3), "WARMING"
    return round(value, 3), "VALID"
