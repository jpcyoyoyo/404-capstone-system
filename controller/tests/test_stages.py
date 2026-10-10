"""Growth-stage schedule: days per stage, automatic stage change and the manual option."""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from greenhouse import stages
from greenhouse.db import Database
from greenhouse.registry import load_registry
from greenhouse.seed import DEFAULT_STAGE_KEY, sync_registry

from .conftest import REGISTRY
from .test_api import Rig

# 10:00 Manila on 13 Oct 2026; local midnight is 16:00 UTC the day before.
NOW = datetime(2026, 10, 13, 2, 0, 0)


def at_day(n: int) -> datetime:
    """10:00 Manila, n days after 13 Oct (day 1)."""
    return NOW + timedelta(days=n - 1)


@pytest.fixture
def sdb(tmp_path):
    reg = load_registry(REGISTRY)
    db = Database(f"sqlite:///{tmp_path}/s.db")
    db.create_all()
    sync_registry(db, reg)
    stages.set_stage(db, reg, "seedling", now=NOW)
    return db, reg


def test_defaults_come_from_the_registry(sdb):
    db, reg = sdb
    i = stages.info(db, reg, NOW)
    assert i["days"] == {"seedling": 14, "growth": 16, "mature": 10}
    assert i["mode"] == "auto" and i["day"] == 1 and i["crop_day"] == 1 and i["crop_days"] == 40
    assert i["next_stage_id"] == "growth" and i["next_change_on"] == "2026-10-27"


def test_auto_advances_after_the_days_are_up(sdb):
    db, reg = sdb
    assert stages.advance_if_due(db, reg, at_day(14)) == []          # last day of seedling
    assert stages.advance_if_due(db, reg, at_day(15)) == [("seedling", "growth")]
    i = stages.info(db, reg, at_day(15))
    assert i["stage_id"] == "growth" and i["day"] == 1 and i["crop_day"] == 15 and i["started_on"] == "2026-10-27"


def test_catches_up_after_the_controller_was_off(sdb):
    db, reg = sdb
    moves = stages.advance_if_due(db, reg, at_day(35))   # seedling 14 + growth 16 = 30 days, now day 35
    assert moves == [("seedling", "growth"), ("growth", "mature")]
    i = stages.info(db, reg, at_day(35))
    assert i["stage_id"] == "mature" and i["day"] == 5 and i["started_on"] == "2026-11-12"


def test_last_stage_never_advances_but_reports_harvest_due(sdb):
    db, reg = sdb
    stages.advance_if_due(db, reg, at_day(45))
    assert db.kv_get(DEFAULT_STAGE_KEY) == "mature"
    assert stages.advance_if_due(db, reg, at_day(60)) == []
    assert stages.info(db, reg, at_day(45))["harvest_due"] is True


def test_manual_mode_holds_the_stage(sdb):
    db, reg = sdb
    stages.set_schedule(db, reg, mode_="manual", now=NOW)
    assert stages.advance_if_due(db, reg, at_day(30)) == []
    i = stages.info(db, reg, at_day(30))
    assert i["stage_id"] == "seedling" and i["day"] == 30 and i["overdue"] and i["next_change_on"] is None


def test_schedule_validation(sdb):
    db, reg = sdb
    for bad in ({"seedling": 0}, {"seedling": 400}, {"seedling": 2.5}, {"nope": 3}):
        with pytest.raises(ValueError):
            stages.set_schedule(db, reg, days=bad, now=NOW)
    with pytest.raises(ValueError):
        stages.set_schedule(db, reg, started_on="2026-12-01", now=NOW)   # future
    changed = stages.set_schedule(db, reg, days={"growth": 20}, now=NOW)
    assert changed["days"]["new"]["growth"] == 20 and stages.info(db, reg, NOW)["crop_days"] == 44


# ── through the API and the control loop ─────────────────────────────────
@pytest.fixture
def rig(tmp_path):
    r = Rig(tmp_path)
    r.cycle()
    return r


def test_api_schedule_and_manual_stage(rig):
    h = rig.login()
    i = rig.client.get("/greenhouse/gh1/stage", headers=h).json()
    assert i["mode"] == "auto" and set(i["days"]) == {"seedling", "growth", "mature"}
    r = rig.client.put("/greenhouse/gh1/stage-schedule", json={"mode": "manual", "days": {"seedling": 12}}, headers=h)
    assert r.status_code == 200 and r.json()["mode"] == "manual" and r.json()["days"]["seedling"] == 12
    assert rig.client.put("/greenhouse/gh1/stage-schedule", json={"days": {"seedling": 0}}, headers=h).status_code == 422
    # the manual option: pick a stage, counting from a date in the past
    start = (stages.today_local() - timedelta(days=3)).isoformat()
    r = rig.client.put("/greenhouse/gh1/stage", json={"stage_id": "growth", "started_on": start}, headers=h).json()
    assert r["stage_id"] == "growth" and r["day"] == 4
    assert rig.control.engine.stage_id == "growth"
    live = rig.client.get("/greenhouse/gh1/live", headers=h).json()
    assert live["stage_schedule"]["day"] == 4
    v = rig.login("viewer@test.ph")
    assert rig.client.put("/greenhouse/gh1/stage-schedule", json={"mode": "auto"}, headers=v).status_code == 403
    audit = rig.client.get("/logs?kind=audit", headers=h).json()
    assert {"stage_schedule_changed", "stage_changed"} <= {a["action"] for a in audit}


def test_control_loop_changes_stage_and_raises_an_event(rig):
    h = rig.login()
    start = (stages.today_local() - timedelta(days=20)).isoformat()   # seedling is 14 days
    rig.client.put("/greenhouse/gh1/stage", json={"stage_id": "seedling", "started_on": start}, headers=h)
    rig.client.put("/greenhouse/gh1/stage-schedule", json={"mode": "auto"}, headers=h)
    rig.control._house_at = None          # housekeeping runs on the next cycle
    rig.cycle()
    assert rig.control.engine.stage_id == "growth"
    # and the control loop does it on its own when the days run out
    rig.client.put("/greenhouse/gh1/stage", json={"stage_id": "growth", "started_on": (stages.today_local() - timedelta(days=16)).isoformat()}, headers=h)
    rig.control._house_at = None
    rig.cycle()
    assert rig.control.engine.stage_id == "mature"
    codes = [a["code"] for a in rig.client.get("/alerts", headers=h).json()]
    assert "STAGE_CHANGED" in codes
