"""Growth-stage schedule: how many days each stage lasts, and automatic stage change.

The active stage is kept in the key/value table (``active_stage``, see seed.py). This module adds:

* ``stage_mode``        ``auto`` (default) or ``manual``
* ``stage_days``        JSON ``{stage_id: days}``; missing stages use the registry default
* ``stage_started_on``  local date (YYYY-MM-DD) the active stage began; day 1 is that date

In ``auto`` mode the control service calls :func:`advance_if_due` about once a minute. When the
active stage has run for all its days, the next stage starts the following local day, anchored to
the planned date (so a controller that was switched off catches up instead of drifting). The last
stage never advances by itself: once its days are over the schedule reports ``harvest_due`` and
the staff start a new crop (seedling, day 1) from the app.

In ``manual`` mode the stage stays where an administrator puts it; days are still counted for
display. Choosing a stage by hand in either mode starts that stage today.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from typing import Any

from .db import Database
from .registry import Registry
from .seed import DEFAULT_STAGE_KEY
from .timeutil import local_time_of, utcnow

MODE_KEY = "stage_mode"
DAYS_KEY = "stage_days"
STARTED_KEY = "stage_started_on"
MODES = ("auto", "manual")
MAX_DAYS = 365


def today_local(now: datetime | None = None) -> date:
    return local_time_of(now or utcnow()).date()


def _days(db: Database, reg: Registry) -> dict[str, int]:
    out = {st.id: int(st.days) for st in reg.stages}
    try:
        saved = json.loads(db.kv_get(DAYS_KEY) or "{}")
    except ValueError:
        saved = {}
    for k, v in saved.items():
        if k in out and isinstance(v, int) and 1 <= v <= MAX_DAYS:
            out[k] = v
    return out


def _started_on(db: Database, today: date) -> date:
    raw = db.kv_get(STARTED_KEY)
    try:
        return date.fromisoformat(raw) if raw else today
    except ValueError:
        return today


def mode(db: Database) -> str:
    m = db.kv_get(MODE_KEY) or "auto"
    return m if m in MODES else "auto"


def info(db: Database, reg: Registry, now: datetime | None = None) -> dict[str, Any]:
    """Everything the app shows about the schedule. Pure read; never changes the stage."""
    today = today_local(now)
    if db.kv_get(STARTED_KEY) is None:   # first run after the upgrade: count from today
        db.kv_set(STARTED_KEY, today.isoformat())
    stage_id = db.kv_get(DEFAULT_STAGE_KEY) or reg.stages[0].id
    days = _days(db, reg)
    order = [st.id for st in sorted(reg.stages, key=lambda s: s.sequence)]
    idx = order.index(stage_id) if stage_id in order else 0
    started = _started_on(db, today)
    day = max(1, (today - started).days + 1)
    length = days[stage_id]
    nxt = order[idx + 1] if idx + 1 < len(order) else None
    ends_on = started + timedelta(days=length - 1)
    before = sum(days[s] for s in order[:idx])
    m = mode(db)
    return {
        "mode": m,
        "stage_id": stage_id,
        "started_on": started.isoformat(),
        "day": day,
        "stage_days": length,
        "days_left": max(0, length - day),
        "ends_on": ends_on.isoformat(),
        "next_stage_id": nxt,
        # When the next stage starts on its own (auto mode only; None for the last stage or in manual).
        "next_change_on": (ends_on + timedelta(days=1)).isoformat() if (m == "auto" and nxt) else None,
        "crop_day": before + day,
        "crop_days": sum(days.values()),
        "harvest_due": nxt is None and day > length,
        "overdue": day > length,
        "days": days,
        "order": order,
    }


def advance_if_due(db: Database, reg: Registry, now: datetime | None = None) -> list[tuple[str, str]]:
    """In auto mode, move through every stage whose days are over. Returns the (old, new) changes."""
    if mode(db) != "auto":
        return []
    today = today_local(now)
    if db.kv_get(STARTED_KEY) is None:
        db.kv_set(STARTED_KEY, today.isoformat())
        return []
    days = _days(db, reg)
    order = [st.id for st in sorted(reg.stages, key=lambda s: s.sequence)]
    stage_id = db.kv_get(DEFAULT_STAGE_KEY) or order[0]
    started = _started_on(db, today)
    changes: list[tuple[str, str]] = []
    while stage_id in order and order.index(stage_id) + 1 < len(order):
        next_start = started + timedelta(days=days[stage_id])
        if today < next_start:
            break
        nxt = order[order.index(stage_id) + 1]
        changes.append((stage_id, nxt))
        stage_id, started = nxt, next_start
    if changes:
        db.kv_set(DEFAULT_STAGE_KEY, stage_id)
        db.kv_set(STARTED_KEY, started.isoformat())
    return changes


def validate_days(reg: Registry, days: dict[str, Any]) -> dict[str, int]:
    ids = {st.id for st in reg.stages}
    out: dict[str, int] = {}
    for k, v in days.items():
        if k not in ids:
            raise ValueError(f"unknown stage {k}")
        if isinstance(v, bool) or not isinstance(v, (int, float)) or int(v) != v:
            raise ValueError(f"{k}: days must be a whole number")
        if not 1 <= int(v) <= MAX_DAYS:
            raise ValueError(f"{k}: days must be between 1 and {MAX_DAYS}")
        out[k] = int(v)
    return out


def set_schedule(db: Database, reg: Registry, *, mode_: str | None = None, days: dict[str, Any] | None = None,
                 started_on: str | None = None, now: datetime | None = None) -> dict[str, Any]:
    """Change the mode, the stage lengths and/or the date the active stage began. Returns what changed."""
    changed: dict[str, Any] = {}
    if mode_ is not None:
        if mode_ not in MODES:
            raise ValueError("mode must be auto or manual")
        if mode_ != mode(db):
            changed["mode"] = {"old": mode(db), "new": mode_}
            db.kv_set(MODE_KEY, mode_)
    if days is not None:
        clean = validate_days(reg, days)
        merged = {**_days(db, reg), **clean}
        old = _days(db, reg)
        if merged != old:
            changed["days"] = {"old": old, "new": merged}
            db.kv_set(DAYS_KEY, json.dumps(merged, sort_keys=True))
    if started_on is not None:
        try:
            d = date.fromisoformat(started_on)
        except ValueError:
            raise ValueError("started_on must be a date (YYYY-MM-DD)")
        today = today_local(now)
        if d > today:
            raise ValueError("the stage cannot start in the future")
        if (today - d).days > MAX_DAYS:
            raise ValueError("that date is too far back")
        old = db.kv_get(STARTED_KEY)
        if old != d.isoformat():
            changed["started_on"] = {"old": old, "new": d.isoformat()}
            db.kv_set(STARTED_KEY, d.isoformat())
    return changed


def set_stage(db: Database, reg: Registry, stage_id: str, started_on: date | None = None,
              now: datetime | None = None) -> str | None:
    """Make ``stage_id`` active, counting from ``started_on`` (default today). Returns the previous stage."""
    reg.stage(stage_id)   # KeyError if unknown
    old = db.kv_get(DEFAULT_STAGE_KEY)
    db.kv_set(DEFAULT_STAGE_KEY, stage_id)
    db.kv_set(STARTED_KEY, (started_on or today_local(now)).isoformat())
    return old
