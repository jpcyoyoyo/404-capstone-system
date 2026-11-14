"""Cloud sync: bulk upsert on the cloud side, small tables first, progress per request."""
from datetime import timedelta

from sqlalchemy import func, select

from greenhouse.models import SensorReading, User
from greenhouse.services import sync as syncmod
from greenhouse.services.sync import SyncService
from greenhouse.timeutil import utcnow

from .test_api import Rig


def _add_readings(db, n):
    now = utcnow()
    with db.session() as s:
        s.add_all([SensorReading(sensor_id="temp_z1_01", value=20 + i % 10, raw=1.0, unit="°C", quality="VALID",
                                 recorded_at=now - timedelta(seconds=n - i)) for i in range(n)])


def _count(db, model):
    with db.session() as s:
        return s.execute(select(func.count()).select_from(model)).scalar()


def test_backlog_goes_in_batches_after_the_small_tables(tmp_path, monkeypatch):
    monkeypatch.setattr(syncmod, "BATCH", 500)
    monkeypatch.setattr(syncmod, "UPSERT_CHUNK", 120)       # several statements per request
    pi = Rig(tmp_path); cloud = Rig(tmp_path, role="cloud")
    _add_readings(pi.db, 1300)
    order, progress = [], []

    def post(table, rows):
        order.append((table, len(rows)))
        r = cloud.client.post("/sync/ingest", json={"table": table, "rows": rows}, headers={"Authorization": "Bearer sync-tok"})
        assert r.status_code == 200, r.text

    sent = SyncService(pi.db, "http://cloud", "sync-tok", post=post).sync_once(progress=progress.append)
    tables = [t for t, _ in order]
    # settings and accounts arrive before the readings backlog, so sign-in works on the cloud at once
    assert tables.index("users") < tables.index("sensor_readings")
    assert [n for t, n in order if t == "sensor_readings"] == [500, 500, 300]
    assert sum(progress) == sent and len(progress) == len(order)
    assert _count(cloud.db, SensorReading) == _count(pi.db, SensorReading) == 1300
    assert cloud.login()                                   # the Pi's account works on the cloud


def test_ingest_is_an_upsert(tmp_path):
    cloud = Rig(tmp_path, role="cloud")
    pi = Rig(tmp_path)
    with pi.db.session() as s:
        users = [syncmod.row_to_dict(u) for u in s.execute(select(User)).scalars()]
    assert syncmod.ingest(cloud.db, "users", users) == len(users)
    assert syncmod.ingest(cloud.db, "users", users) == len(users)    # resent after a timeout: no duplicates
    assert _count(cloud.db, User) == len(users)
    users[0]["name"] = "Renamed"
    syncmod.ingest(cloud.db, "users", users)
    with cloud.db.session() as s:
        assert s.get(User, users[0]["id"]).name == "Renamed"
    assert syncmod.ingest(cloud.db, "users", []) == 0


def test_status_shows_progress_while_a_pass_is_still_running(tmp_path, monkeypatch):
    from greenhouse import cloud as cloudmod
    monkeypatch.setattr(syncmod, "BATCH", 200)
    pi = Rig(tmp_path)
    _add_readings(pi.db, 450)
    seen = []

    def post(table, rows):
        if table == "sensor_readings" and seen:             # the second readings request times out
            raise TimeoutError("The read operation timed out")
        if table == "sensor_readings":
            seen.append(len(rows))

    svc = SyncService(pi.db, "http://cloud", "sync-tok", post=post)
    svc.run_pass()
    st = cloudmod.read_status(pi.db)
    assert st["last_ok_at"] is not None                     # earlier requests were recorded
    assert "timed out" in st["last_error"]
    assert pi.db.kv_get("sync:sensor_readings") is not None   # and the watermark kept them


def test_cloud_knows_whether_the_greenhouse_controller_is_running(tmp_path, monkeypatch):
    """The cloud has no MQTT link to the Pi: the control heartbeat travels with the settings.
    Before 14 Nov 2026 /health on the cloud always said controller_online false."""
    from greenhouse import cloud as cloudmod
    from greenhouse.services import api as apimod
    pi = Rig(tmp_path); cloud = Rig(tmp_path, role="cloud")
    assert cloud.client.get("/health").json()["controller_online"] is False      # nothing uploaded yet
    pi.cycle()                                                                    # control publishes its heartbeat
    assert pi.db.kv_get(cloudmod.CONTROLLER_STATUS_KEY)

    def post(table, rows):
        r = cloud.client.post("/sync/ingest", json={"table": table, "rows": rows}, headers={"Authorization": "Bearer sync-tok"})
        assert r.status_code == 200, r.text

    SyncService(pi.db, "http://cloud", "sync-tok", post=post).sync_once()
    assert cloud.client.get("/health").json()["controller_online"] is True
    live = cloud.client.get("/greenhouse/gh1/live", headers=cloud.login()).json()
    assert live["controller"]["online"] is True
    soil = live["readings"]["soil_z1_01"]
    assert soil["quality"] == "VALID" and soil["value"] is not None

    # two minutes later (one sync interval behind the Pi) the values still show, not STALE
    later = utcnow() + timedelta(seconds=150)
    monkeypatch.setattr(apimod, "utcnow", lambda: later)
    live = cloud.client.get("/greenhouse/gh1/live", headers=cloud.login()).json()
    assert live["controller"]["online"] is True and live["readings"]["soil_z1_01"]["quality"] == "VALID"
    # the control service stopped: no new heartbeat, so the cloud says so once the grace runs out
    later = utcnow() + timedelta(seconds=400)
    assert cloud.client.get("/health").json()["controller_online"] is False
