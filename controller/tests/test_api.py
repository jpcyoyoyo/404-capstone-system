"""API tests: the whole controller in one process (memory bus, simulator, SQLite)."""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from greenhouse.bus import MemoryBus
from greenhouse.config import Settings
from greenhouse.db import Database
from greenhouse.hal.sim import Environment, SimHal
from greenhouse.registry import load_registry
from greenhouse.seed import create_user, sync_registry
from greenhouse.services.api import create_app
from greenhouse.services.control import ControlService
from greenhouse.services.sensors import SensorService
from greenhouse.services.simnodes import SimNodes
from greenhouse.timeutil import iso, utcnow

from .conftest import REGISTRY


class Rig:
    def __init__(self, tmp_path, role="controller"):
        self.settings = Settings(database_url=f"sqlite:///{tmp_path}/{role}.db", mqtt_host="memory", role=role,
                                 jwt_secret="test-secret", ack_timeout_s=2, enable_sim_api=True, sync_token="sync-tok")
        self.reg = load_registry(REGISTRY)
        self.db = Database(self.settings.database_url)
        self.db.create_all()
        sync_registry(self.db, self.reg)
        from greenhouse.__main__ import _seed_sim_calibrations
        _seed_sim_calibrations(self.db, self.reg)
        create_user(self.db, "admin@test.ph", "password123", "Admin", "admin")
        create_user(self.db, "viewer@test.ph", "password123", "Viewer", "viewer")
        self.bus = MemoryBus()
        self.env = Environment(self.reg, seed=1)
        self.hal = SimHal(self.reg, self.env)
        self.sensors = SensorService(self.reg, self.db, self.bus, self.hal)
        self.control = ControlService(self.reg, self.db, self.bus, self.hal, cycle_s=30)
        self.nodes = SimNodes(self.reg, self.bus, self.env)
        self.app = create_app(self.settings, self.reg, self.db, self.bus)
        self.client = TestClient(self.app)
        if role == "controller":
            # start without background threads: drive everything explicitly
            self.control.engine.boot(utcnow())
            self.bus.subscribe(self.control.topics.reading(), self.control._on_reading)
            self.bus.subscribe(self.control.topics.node_status(), self.control._on_node_status)
            self.bus.subscribe(self.control.topics.cmd(), self.control._on_cmd)
            self.bus.subscribe(self.control.topics.config_changed, self.control._on_config)
            self.bus.subscribe(self.sensors.topics.node_raw(), self.sensors._on_node_raw)
            self.bus.subscribe(self.nodes.topics.actuator_state(), self.nodes._on_actuator)
            self.bus.subscribe(f"{self.nodes.topics.base}/sim/fault", self.nodes._on_fault)

    def cycle(self):
        self.nodes.publish_once()
        self.sensors.poll_once(force=True)
        return self.control.tick()

    def login(self, email="admin@test.ph"):
        r = self.client.post("/auth/login", json={"email": email, "password": "password123"})
        assert r.status_code == 200, r.text
        return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture
def rig(tmp_path):
    r = Rig(tmp_path)
    r.cycle()
    return r


def test_login_and_me(rig):
    assert rig.client.post("/auth/login", json={"email": "admin@test.ph", "password": "wrong"}).status_code == 401
    h = rig.login()
    me = rig.client.get("/auth/me", headers=h).json()
    assert me["role"] == "admin"
    assert rig.client.get("/greenhouse", headers={}).status_code == 401


def test_refresh_and_logout_revokes(rig):
    r = rig.client.post("/auth/login", json={"email": "admin@test.ph", "password": "password123"}).json()
    r2 = rig.client.post("/auth/refresh", json={"refresh_token": r["refresh_token"]})
    assert r2.status_code == 200
    h = {"Authorization": f"Bearer {r2.json()['access_token']}"}
    assert rig.client.post("/auth/logout", headers=h).status_code == 200
    assert rig.client.get("/auth/me", headers=h).status_code == 401


def test_live_snapshot(rig):
    h = rig.login()
    live = rig.client.get("/greenhouse/gh1/live", headers=h).json()
    assert live["controller"]["online"]
    soil = live["readings"]["soil_z1_01"]
    assert soil["quality"] == "VALID" and 0 < soil["value"] < 100
    assert live["zones"]["soil_moisture"]["value"] is not None
    assert "irrigation" in live["actuators"]
    assert live["actuators"]["fan_exhaust"]["lockout"] == "NOT_INSTALLED"


def test_command_round_trip_and_idempotency(rig):
    h = rig.login()
    cmd_id = str(uuid.uuid4())
    body = {"cmd_id": cmd_id, "action": "ON", "duration_s": 120, "circuit": "drip"}
    r = rig.client.post("/actuator/irrigation/command", json=body, headers=h).json()
    assert r["status"] == "ACCEPTED", r
    assert rig.control.engine.state["pump"].on and rig.control.engine.state["valve_drip"].on
    assert rig.hal.outputs["pump"] is True
    again = rig.client.post("/actuator/irrigation/command", json=body, headers=h).json()
    assert again["status"] == "ACCEPTED" and again.get("replayed")
    logs = rig.client.get("/logs?kind=audit", headers=h).json()
    assert any(l["action"] == "command_accepted" for l in logs)
    events = rig.client.get("/logs?kind=events&actuator=pump", headers=h).json()
    assert any(e["action"] == "ON" for e in events)


def test_expired_command(rig):
    h = rig.login()
    old = iso(utcnow() - timedelta(seconds=90))
    r = rig.client.post("/actuator/lights/command", json={"action": "ON", "ts": old}, headers=h).json()
    assert r["status"] == "EXPIRED"


def test_viewer_cannot_command(rig):
    h = rig.login("viewer@test.ph")
    r = rig.client.post("/actuator/lights/command", json={"action": "ON"}, headers=h)
    assert r.status_code == 403


def test_low_water_rejects_irrigation(rig):
    h = rig.login()
    rig.client.post("/sim/fault", json={"kind": "drain", "value": 5}, headers=h)
    rig.cycle()
    r = rig.client.post("/actuator/irrigation/command", json={"action": "ON"}, headers=h).json()
    assert r["status"] == "REJECTED" and r["reason"] == "LOW_WATER"
    alerts = rig.client.get("/alerts?status=open", headers=h).json()
    low = [a for a in alerts if a["code"] == "LOW_WATER"]
    assert low and low[0]["severity"] == "critical"
    ack = rig.client.post(f"/alerts/{low[0]['id']}/ack", headers=h).json()
    assert ack["acknowledged_by"] == "admin@test.ph"


def test_invalid_sensor_flagged_not_zero(rig):
    h = rig.login()
    rig.client.post("/sim/fault", json={"kind": "force", "sensor_id": "soil_z1_02", "value": 0}, headers=h)
    rig.cycle()
    live = rig.client.get("/greenhouse/gh1/live", headers=h).json()
    r = live["readings"]["soil_z1_02"]
    assert r["quality"] == "INVALID" and r["value"] is None and r["raw"] == 0
    assert live["zones"]["soil_moisture"]["zones"]["1"]["valid"] == 2


def test_thresholds_and_stage(rig):
    h = rig.login()
    thr = rig.client.get("/thresholds/growth", headers=h).json()
    assert {t["parameter"] for t in thr} >= {"soil_moisture", "temperature"}
    r = rig.client.put("/thresholds/growth", json=[{"parameter": "soil_moisture", "min": 58, "max": 74}], headers=h)
    assert r.status_code == 200
    soil = next(t for t in r.json() if t["parameter"] == "soil_moisture")
    assert soil["min"] == 58 and soil["version"] == 2
    assert rig.client.put("/thresholds/growth", json=[{"parameter": "soil_moisture", "min": 80, "max": 70}],
                          headers=h).status_code == 422
    rig.client.put("/greenhouse/gh1/stage", json={"stage_id": "growth"}, headers=h)
    assert rig.control.engine.stage_id == "growth"
    assert rig.control.engine.bands["soil_moisture"].lo == 58      # takes effect in the control loop
    v = rig.login("viewer@test.ph")
    assert rig.client.put("/thresholds/growth", json=[], headers=v).status_code == 403


def test_calibration_two_point(rig):
    h = rig.login()
    r = rig.client.post("/calibration/ph_01", headers=h, json={
        "kind": "two_point", "points": [{"raw": 1.25, "ref": 6.86}, {"raw": 1.52, "ref": 4.01}, {"raw": 1.0, "ref": 9.18}]})
    assert r.status_code == 200
    c = r.json()["constants"]
    assert c["slope"] < 0 and "verify" in c
    lst = rig.client.get("/calibration", headers=h).json()
    assert any(x["sensor_id"] == "ph_01" and x["days_since"] == 0 for x in lst)


def test_estop(rig):
    h = rig.login()
    rig.client.post("/actuator/irrigation/command", json={"action": "ON"}, headers=h)
    assert rig.control.engine.state["pump"].on
    r = rig.client.post("/actuator/all/command", json={"action": "ESTOP"}, headers=h).json()
    assert r["status"] == "ACCEPTED"
    assert not any(st.on for st in rig.control.engine.state.values())
    alerts = rig.client.get("/alerts?status=all", headers=h).json()
    assert any(a["code"] == "ESTOP" for a in alerts)


def test_fertigation_dose(rig):
    import time
    h = rig.login()
    r = rig.client.post("/actuator/auger/command", json={"action": "DOSE", "target_g": 20}, headers=h).json()
    assert r["status"] == "ACCEPTED", r
    for _ in range(100):
        rep = rig.client.get("/reports/fertilizer", headers=h).json()
        if rep["count"]:
            break
        time.sleep(0.05)
    d = rep["doses"][0]
    assert d["status"] == "complete" and abs(d["delivered_g"] - 20) <= 3


def test_users_admin(rig):
    h = rig.login()
    r = rig.client.post("/users", json={"email": "new@test.ph", "name": "New", "password": "password123"}, headers=h)
    assert r.status_code == 200 and r.json()["role"] == "viewer"
    assert len(rig.client.get("/users", headers=h).json()) == 3


def test_kiosk_token_is_read_only(rig):
    t = rig.client.get("/auth/kiosk").json()["access_token"]
    h = {"Authorization": f"Bearer {t}"}
    assert rig.client.get("/greenhouse/gh1/live", headers=h).status_code == 200
    assert rig.client.post("/actuator/lights/command", json={"action": "ON"}, headers=h).status_code == 403


def test_history(rig):
    h = rig.login()
    for _ in range(3):
        rig.cycle()
    r = rig.client.get("/greenhouse/gh1/history?type=soil_moisture&zone=1&resolution=raw", headers=h).json()
    assert len(r["series"]["soil_z1_01"]) >= 3
    r = rig.client.get("/greenhouse/gh1/history?sensor=temp_z1_01&resolution=1h", headers=h).json()
    assert r["series"]["temp_z1_01"][0]["n"] >= 3


def test_sync_to_cloud(tmp_path, rig):
    from greenhouse.services.sync import SyncService
    cloud = Rig(tmp_path, role="cloud")

    def post(table, rows):
        r = cloud.client.post("/sync/ingest", json={"table": table, "rows": rows}, headers={"Authorization": "Bearer sync-tok"})
        assert r.status_code == 200, r.text
    svc = SyncService(rig.db, "http://cloud", "sync-tok", post=post)
    n1 = svc.sync_once()
    assert n1 > 0
    rig.cycle()
    n2 = svc.sync_once()
    from sqlalchemy import func, select
    from greenhouse.models import SensorReading
    with rig.db.session() as s:
        local = s.execute(select(func.count()).select_from(SensorReading)).scalar()
    with cloud.db.session() as s:
        remote = s.execute(select(func.count()).select_from(SensorReading)).scalar()
    assert local == remote                      # no gaps, no duplicates
    h = cloud.login()
    r = cloud.client.post("/actuator/lights/command", json={"action": "ON"}, headers=h).json()
    assert r["status"] == "REJECTED" and r["reason"] == "REMOTE_READ_ONLY"


def test_stop_a_running_dose(rig):
    import time
    h = rig.login()
    assert rig.client.post("/actuator/auger/command", json={"action": "DOSE", "target_g": 400}, headers=h).json()["status"] == "ACCEPTED"
    time.sleep(0.3)
    r = rig.client.post("/actuator/auger/command", json={"action": "OFF"}, headers=h).json()
    assert r["status"] == "ACCEPTED", r
    for _ in range(100):
        rep = rig.client.get("/reports/fertilizer", headers=h).json()
        if rep["count"]:
            break
        time.sleep(0.05)
    d = rep["doses"][0]
    assert d["status"] == "aborted" and d["reason"] == "STOPPED" and d["delivered_g"] < 400


def test_change_own_password(rig):
    h = rig.login()
    bad = rig.client.post("/auth/password", json={"current_password": "nope", "new_password": "newpassword1"}, headers=h)
    assert bad.status_code == 400
    ok = rig.client.post("/auth/password", json={"current_password": "password123", "new_password": "newpassword1"}, headers=h)
    assert ok.status_code == 200 and ok.json()["access_token"]
    assert rig.client.get("/auth/me", headers=h).status_code == 401          # old sessions revoked
    r = rig.client.post("/auth/login", json={"email": "admin@test.ph", "password": "newpassword1"})
    assert r.status_code == 200
