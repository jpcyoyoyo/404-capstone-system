"""Turns raw sensor values into engineering units using constants stored in the calibrations table.

Constants live in the database, never in code, so recalibration from the app
takes effect without a software release (Integration Plan §2.4).
"""
from __future__ import annotations

from typing import Any


class NeedsCalibration(Exception):
    pass


def apply(kind: str, raw: float, constants: dict[str, Any] | None, *, extra: dict[str, Any] | None = None,
          water_temp_c: float | None = None) -> float:
    extra = extra or {}
    if kind == "none":
        return raw
    if not constants:
        raise NeedsCalibration(kind)
    if kind == "dry_wet":
        # Capacitive soil probes read HIGHER when dry. 0 % at the dry reference, 100 % at the wet one.
        dry, wet = float(constants["dry"]), float(constants["wet"])
        if dry == wet:
            raise NeedsCalibration("dry == wet")
        pct = (dry - raw) / (dry - wet) * 100.0
        return max(0.0, min(100.0, pct))
    if kind == "two_point":
        # raw is the converter voltage; undo the 2:1 divider before the pH/EC fit.
        volts = raw * float(extra.get("divider", 1.0))
        value = float(constants["slope"]) * volts + float(constants["intercept"])
        if water_temp_c is not None and constants.get("compensate", True):
            if "ph" in constants.get("kind", "ph"):
                # Nernst slope scales with absolute temperature; referenced to 25 °C.
                value = 7.0 + (value - 7.0) * (298.15 / (water_temp_c + 273.15))
            else:
                value = value / (1.0 + 0.02 * (water_temp_c - 25.0))
        return value
    if kind == "scale":
        return (raw - float(constants.get("offset", 0.0))) / float(constants["scale"])
    raise NeedsCalibration(f"unknown calibration kind {kind}")


def two_point_fit(v1: float, ref1: float, v2: float, ref2: float) -> dict[str, float]:
    """Slope and intercept from two buffer readings (voltages already corrected for the divider)."""
    if v1 == v2:
        raise ValueError("the two readings are identical")
    slope = (ref2 - ref1) / (v2 - v1)
    return {"slope": slope, "intercept": ref1 - slope * v1}
