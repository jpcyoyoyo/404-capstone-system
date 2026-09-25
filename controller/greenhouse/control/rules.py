"""Threshold rules: each parameter turns its zone-aggregated value into actuator requests.

Hysteresis (§3.3) is built into every rule so relays do not chatter around a setpoint.
"""
from __future__ import annotations

from .types import (RULE_COUPLING, RULE_GATING, RULE_THRESHOLD, Band, ParamState, Request)

# Coupling order for the exhaust fan (§3.5 rule 3): heat stress damages the crop
# faster than humidity or sub-optimal CO₂, so temperature decides first.
COUPLING_RANK = {"temperature": 0, "humidity": 1, "co2": 2}


def fmt(v: float) -> str:
    return f"{v:.0f}" if abs(v) >= 100 else f"{v:.1f}"


def irrigation_request(soil: ParamState, band: Band, irrigating: bool, circuit: str) -> Request | None:
    """Setpoint = band midpoint. ON below setpoint − deadband, OFF above setpoint + deadband, hold between."""
    v = soil.value
    if v is None:
        return None
    lo_trip, hi_trip = band.setpoint - band.deadband, band.setpoint + band.deadband
    if v < lo_trip:
        return Request("irrigation", True, RULE_THRESHOLD, "soil_moisture",
                       f"soil moisture {fmt(v)}% < {fmt(lo_trip)}%", circuit=circuit)
    if v > hi_trip:
        return Request("irrigation", False, RULE_THRESHOLD, "soil_moisture",
                       f"soil moisture {fmt(v)}% > {fmt(hi_trip)}%", circuit=circuit)
    return Request("irrigation", irrigating, RULE_THRESHOLD, "soil_moisture",
                   f"soil moisture {fmt(v)}% within deadband — holding", circuit=circuit)


def climate_requests(params: dict[str, ParamState], bands: dict[str, Band], fan_on: bool) -> list[Request]:
    """Exhaust-fan requests from temperature, humidity and CO₂.

    - temperature above max → ventilate; below min → keep closed to hold heat
    - humidity above max → ventilate; below min → keep closed
    - CO₂ above max → ventilate; below min → keep closed to conserve CO₂
    A parameter that is already ventilating keeps asking until it is back below
    max − deadband (hysteresis). Conflicts are resolved by arbitration using COUPLING_RANK.
    """
    reqs: list[Request] = []
    units = {"temperature": "°C", "humidity": "%", "co2": " ppm"}
    for p in ("temperature", "humidity", "co2"):
        ps = params.get(p)
        band = bands.get(p)
        if ps is None or band is None or ps.value is None:
            continue
        v, u = ps.value, units[p]
        if v > band.hi:
            reqs.append(Request("fan_exhaust", True, RULE_COUPLING, p, f"{p} {fmt(v)}{u} above max {fmt(band.hi)}{u}",
                                rank=COUPLING_RANK[p]))
        elif fan_on and v > band.hi - band.deadband:
            reqs.append(Request("fan_exhaust", True, RULE_COUPLING, p,
                                f"{p} {fmt(v)}{u} not yet below {fmt(band.hi - band.deadband)}{u}", rank=COUPLING_RANK[p]))
        elif v < band.lo:
            reqs.append(Request("fan_exhaust", False, RULE_COUPLING, p, f"{p} {fmt(v)}{u} below min {fmt(band.lo)}{u}",
                                rank=COUPLING_RANK[p]))
    if not reqs:
        reqs.append(Request("fan_exhaust", False, RULE_THRESHOLD, "climate", "temperature, humidity and CO₂ in range"))
    return reqs


def lighting_request(light: ParamState, band: Band, in_photoperiod: bool, lights_on: bool) -> Request:
    if not in_photoperiod:
        return Request("lights", False, RULE_THRESHOLD, "light", "outside photoperiod")
    v = light.value
    if v is None:
        return Request("lights", lights_on, RULE_THRESHOLD, "light", "no valid light reading — holding")
    if v < band.lo:
        return Request("lights", True, RULE_THRESHOLD, "light", f"light {fmt(v)} lux < {fmt(band.lo)} lux")
    if lights_on and v < band.lo + band.deadband:
        return Request("lights", True, RULE_THRESHOLD, "light", f"light {fmt(v)} lux not yet above {fmt(band.lo + band.deadband)} lux")
    return Request("lights", False, RULE_THRESHOLD, "light", f"light {fmt(v)} lux sufficient")


def fertigation_gate(soil: ParamState | None, ec: ParamState | None, bands: dict[str, Band]) -> tuple[bool, str | None]:
    """§3.5 rule 4: no fertigation when soil is at/above its upper bound or EC at/above the stage max."""
    if soil is not None and soil.value is not None and "soil_moisture" in bands and soil.value >= bands["soil_moisture"].hi:
        return False, f"FERTIGATION_GATED: soil moisture {fmt(soil.value)}% at or above {fmt(bands['soil_moisture'].hi)}%"
    if ec is not None and ec.value is not None and "ec" in bands and ec.value >= bands["ec"].hi:
        return False, f"FERTIGATION_GATED: EC {ec.value:.2f} at or above {bands['ec'].hi:.2f} mS/cm"
    return True, None


def fertigation_request(ec: ParamState | None, bands: dict[str, Band]) -> Request | None:
    if ec is None or ec.value is None or "ec" not in bands:
        return None
    b = bands["ec"]
    if ec.value < b.lo - b.deadband:
        return Request("auger", True, RULE_GATING, "ec", f"EC {ec.value:.2f} < {b.lo - b.deadband:.2f} mS/cm")
    return None
