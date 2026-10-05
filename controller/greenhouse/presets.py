"""Plant threshold presets: a named set of bands for all three growth stages.

A preset holds ``bands = {stage: {param: {"min", "max", "deadband"}}}`` for every stage and every
parameter in ``PARAMS``. Applying one writes all of those rows into ``thresholds`` in one go, so the
control engine never runs with a mix of two plants' bands.

The built-in "petchay" preset is rebuilt from ``contract/registry.yaml`` on every start and cannot
be edited or deleted; user presets live only in the database. Deleting a user preset only marks it
deleted, because cloud sync copies snapshot tables by merging and would otherwise keep showing it.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import select

from .db import Database
from .models import Threshold, ThresholdPreset
from .registry import PARAMS, Registry
from .timeutil import iso, utcnow

BUILTIN_ID = "petchay"
BUILTIN_NAME = "Petchay (default)"
ACTIVE_KEY = "active_preset"
MODIFIED_KEY = "active_preset_modified"

Bands = dict[str, dict[str, dict[str, float]]]


def builtin_bands(reg: Registry) -> Bands:
    return {st.id: {p: {"min": float(lo), "max": float(hi), "deadband": float(reg.deadbands.get(p, 0.0))}
                    for p, (lo, hi) in reg.default_thresholds[st.id].items()}
            for st in reg.stages}


def current_bands(db: Database, reg: Registry) -> Bands:
    out: Bands = {st.id: {} for st in reg.stages}
    with db.session() as s:
        for t in s.execute(select(Threshold)).scalars():
            if t.stage_id in out and t.parameter in PARAMS:
                out[t.stage_id][t.parameter] = {"min": t.min_value, "max": t.max_value, "deadband": t.deadband}
    return out


def same_bands(a: Bands, b: Bands) -> bool:
    for stage in set(a) | set(b):
        sa, sb = a.get(stage, {}), b.get(stage, {})
        if set(sa) != set(sb):
            return False
        for p, band in sa.items():
            for k in ("min", "max", "deadband"):
                if abs(float(band[k]) - float(sb[p][k])) > 1e-9:
                    return False
    return True


def validate_bands(reg: Registry, bands: Any) -> Bands:
    """Return a clean copy of ``bands`` or raise ValueError naming the first problem."""
    if not isinstance(bands, dict):
        raise ValueError("bands must be an object of stages")
    plaus = reg.raw.get("sensor_defaults", {}).get("plausible", {})
    stage_ids = [st.id for st in reg.stages]
    extra = set(bands) - set(stage_ids)
    if extra:
        raise ValueError(f"unknown stage {sorted(extra)[0]}")
    out: Bands = {}
    for stage in stage_ids:
        sb = bands.get(stage)
        if not isinstance(sb, dict):
            raise ValueError(f"{stage}: missing")
        unknown = set(sb) - set(PARAMS)
        if unknown:
            raise ValueError(f"{stage}: unknown parameter {sorted(unknown)[0]}")
        out[stage] = {}
        for p in PARAMS:
            band = sb.get(p)
            if not isinstance(band, dict):
                raise ValueError(f"{stage} {p}: missing")
            try:
                lo, hi = float(band["min"]), float(band["max"])
                db_ = float(band.get("deadband", reg.deadbands.get(p, 0.0)))
            except (KeyError, TypeError, ValueError):
                raise ValueError(f"{stage} {p}: min and max must be numbers")
            if lo >= hi:
                raise ValueError(f"{stage} {p}: min must be below max")
            plo, phi = plaus.get(p, [-1e9, 1e9])
            if lo < plo or hi > phi:
                raise ValueError(f"{stage} {p}: must be within {plo}–{phi}")
            if db_ < 0:
                raise ValueError(f"{stage} {p}: deadband cannot be negative")
            out[stage][p] = {"min": lo, "max": hi, "deadband": db_}
    return out


def preset_dict(p: ThresholdPreset) -> dict:
    return {"id": p.id, "name": p.name, "note": p.note or "", "builtin": p.builtin, "bands": p.bands,
            "created_by": p.created_by, "created_at": iso(p.created_at),
            "updated_by": p.updated_by, "updated_at": iso(p.updated_at)}


def active_info(db: Database) -> dict | None:
    pid = db.kv_get(ACTIVE_KEY)
    if not pid:
        return None
    with db.session() as s:
        p = s.get(ThresholdPreset, pid)
        if p is None or p.deleted_at is not None:
            return None
        name = p.name
    return {"id": pid, "name": name, "modified": db.kv_get(MODIFIED_KEY) == "1"}


def sync_builtin(db: Database, reg: Registry) -> None:
    """Upsert the built-in preset from the registry; on first run, mark it active if it matches."""
    bands = builtin_bands(reg)
    with db.session() as s:
        row = s.get(ThresholdPreset, BUILTIN_ID)
        if row is None:
            s.add(ThresholdPreset(id=BUILTIN_ID, name=BUILTIN_NAME, builtin=True, bands=bands,
                                  note="Brassica rapa subsp. chinensis bands from the registry",
                                  created_by="registry", updated_by="registry"))
        elif row.bands != bands or row.name != BUILTIN_NAME or row.deleted_at is not None:
            row.bands, row.name, row.deleted_at = bands, BUILTIN_NAME, None
            row.updated_at, row.updated_by = utcnow(), "registry"
    if db.kv_get(ACTIVE_KEY) is None:
        if same_bands(current_bands(db, reg), bands):
            db.kv_set(ACTIVE_KEY, BUILTIN_ID)
            db.kv_set(MODIFIED_KEY, "0")
        else:
            db.kv_set(ACTIVE_KEY, "")
