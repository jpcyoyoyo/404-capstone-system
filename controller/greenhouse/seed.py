"""Brings the database in line with the registry and creates accounts."""
from __future__ import annotations

from sqlalchemy import select

from .auth import hash_password
from .db import Database
from .models import Actuator, GrowthStage, Sensor, Threshold, User, Zone
from .registry import Registry

DEFAULT_STAGE_KEY = "active_stage"


def sync_registry(db: Database, reg: Registry) -> None:
    """Upsert zones, sensors, actuators and stages; add default thresholds that are missing.

    Existing thresholds are never overwritten: once edited from the app, the
    database copy is authoritative.
    """
    with db.session() as s:
        for z in reg.zones:
            row = s.get(Zone, z.id) or Zone(id=z.id)
            row.name, row.description = z.name, z.description
            s.merge(row)
        s.flush()
        for sd in reg.sensors:
            row = s.get(Sensor, sd.id) or Sensor(id=sd.id)
            row.zone_id, row.type, row.host, row.unit, row.installed = sd.zone, sd.type, sd.host, sd.unit, sd.installed
            s.merge(row)
        for ad in reg.physical_actuators:
            row = s.get(Actuator, ad.id)
            if row is None:
                row = Actuator(id=ad.id, state=False, mode="AUTO")
            row.name, row.kind, row.group, row.installed = ad.name, ad.kind, ad.group, ad.installed
            s.merge(row)
        # Rows the registry no longer lists (e.g. the old `auger` and `hopper_01`, replaced by `doser`
        # and `stock_01` on 4 Oct 2026) are kept for their history but marked not installed.
        known_s = {sd.id for sd in reg.sensors}
        known_a = {ad.id for ad in reg.physical_actuators}
        for row in s.execute(select(Sensor)).scalars():
            if row.id not in known_s:
                row.installed = False
        for row in s.execute(select(Actuator)).scalars():
            if row.id not in known_a:
                row.installed = False
        for st in reg.stages:
            row = s.get(GrowthStage, st.id) or GrowthStage(id=st.id)
            row.name, row.sequence, row.irrigation_mode, row.description = st.name, st.sequence, st.irrigation_mode, st.description
            s.merge(row)
        s.flush()
        existing = {(t.stage_id, t.parameter) for t in s.execute(select(Threshold)).scalars()}
        for stage_id, params in reg.default_thresholds.items():
            for p, (lo, hi) in params.items():
                if (stage_id, p) not in existing:
                    s.add(Threshold(stage_id=stage_id, parameter=p, min_value=lo, max_value=hi,
                                    deadband=reg.deadbands.get(p, 0.0), updated_by="registry"))
    if db.kv_get(DEFAULT_STAGE_KEY) is None:
        db.kv_set(DEFAULT_STAGE_KEY, reg.stages[0].id)
    from .presets import sync_builtin
    sync_builtin(db, reg)


def create_user(db: Database, email: str, password: str, name: str, role: str = "admin") -> User:
    if role not in ("admin", "viewer"):
        raise ValueError("role must be admin or viewer")
    if len(password) < 8:
        raise ValueError("password must be at least 8 characters")
    with db.session() as s:
        existing = s.execute(select(User).where(User.email == email.lower())).scalars().first()
        if existing:
            existing.password_hash = hash_password(password)
            existing.name, existing.role, existing.active = name, role, True
            existing.token_version += 1
            return existing
        u = User(email=email.lower(), name=name, password_hash=hash_password(password), role=role)
        s.add(u)
        s.flush()
        return u
