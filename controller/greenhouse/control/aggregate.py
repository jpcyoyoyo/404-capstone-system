"""Zone aggregation by median (§3.6): a median of three rejects one stuck sensor."""
from __future__ import annotations

from statistics import median

from ..registry import Registry
from .types import ParamState, Reading, ZoneValue


def aggregate(reg: Registry, readings: dict[str, Reading], types: list[str]) -> dict[str, ParamState]:
    out: dict[str, ParamState] = {}
    for t in types:
        ps = ParamState(type=t)
        by_zone: dict[int, list] = {}
        for sd in reg.sensors_of(t):
            by_zone.setdefault(sd.zone, []).append(readings.get(sd.id))
        zone_medians = []
        for z, rs in sorted(by_zone.items()):
            vals = [r.value for r in rs if r is not None and r.valid]
            warming = sum(1 for r in rs if r is not None and r.quality == "WARMING")
            zv = ZoneValue(zone=z, median=median(vals) if vals else None, n_valid=len(vals), n_total=len(rs),
                           n_warming=warming)
            ps.zones[z] = zv
            if zv.faulted:
                ps.manual_required_zones.append(z)
            elif zv.median is not None:
                zone_medians.append(zv.median)
        ps.value = median(zone_medians) if zone_medians else None
        out[t] = ps
    return out
