"""Plant threshold presets: all three stages saved and applied as one set."""
from __future__ import annotations

import copy

import pytest

from greenhouse import presets as presetmod
from greenhouse.registry import PARAMS

from .test_api import Rig


@pytest.fixture
def rig(tmp_path):
    r = Rig(tmp_path)
    r.cycle()
    return r


def lettuce(rig):
    """Petchay bands with every soil-moisture and temperature band moved, as a stand-in second plant."""
    b = copy.deepcopy(presetmod.builtin_bands(rig.reg))
    for stage in b:
        b[stage]["soil_moisture"] = {"min": 65, "max": 85, "deadband": 4}
        b[stage]["temperature"] = {"min": 16, "max": 24, "deadband": 1}
    return b


def test_builtin_preset_is_seeded_and_active(rig):
    h = rig.login()
    r = rig.client.get("/threshold-presets", headers=h).json()
    assert r["active"] == {"id": "petchay", "name": "Petchay (default)", "modified": False}
    builtin = r["presets"][0]
    assert builtin["id"] == "petchay" and builtin["builtin"] is True
    assert set(builtin["bands"]) == {"seedling", "growth", "mature"}
    assert all(set(v) == set(PARAMS) for v in builtin["bands"].values())
    assert builtin["bands"]["growth"]["soil_moisture"] == {"min": 60.0, "max": 75.0, "deadband": 5.0}
    assert rig.client.get("/greenhouse", headers=h).json()["active_preset"]["id"] == "petchay"
    assert rig.client.get("/greenhouse/gh1/live", headers=h).json()["active_preset"]["id"] == "petchay"


def test_create_edit_delete(rig):
    h = rig.login()
    r = rig.client.post("/threshold-presets", json={"name": "Lettuce", "note": "loose-leaf", "bands": lettuce(rig)}, headers=h)
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    assert pid.startswith("p-") and r.json()["builtin"] is False
    # names are unique, ignoring case
    assert rig.client.post("/threshold-presets", json={"name": "lettuce ", "bands": lettuce(rig)}, headers=h).status_code == 409
    r = rig.client.put(f"/threshold-presets/{pid}", json={"name": "Lettuce (Grand Rapids)", "note": ""}, headers=h)
    assert r.status_code == 200 and r.json()["name"] == "Lettuce (Grand Rapids)" and r.json()["note"] == ""
    names = [p["name"] for p in rig.client.get("/threshold-presets", headers=h).json()["presets"]]
    assert names == ["Petchay (default)", "Lettuce (Grand Rapids)"]   # built-in first
    assert rig.client.delete(f"/threshold-presets/{pid}", headers=h).status_code == 200
    assert [p["id"] for p in rig.client.get("/threshold-presets", headers=h).json()["presets"]] == ["petchay"]
    assert rig.client.delete(f"/threshold-presets/{pid}", headers=h).status_code == 404
    # the name is free again once deleted
    assert rig.client.post("/threshold-presets", json={"name": "Lettuce", "bands": lettuce(rig)}, headers=h).status_code == 201
    actions = [a["action"] for a in rig.client.get("/logs?kind=audit", headers=h).json()]
    assert {"preset_created", "preset_updated", "preset_deleted"} <= set(actions)


def test_builtin_is_protected(rig):
    h = rig.login()
    assert rig.client.put("/threshold-presets/petchay", json={"name": "Mine"}, headers=h).status_code == 409
    assert rig.client.delete("/threshold-presets/petchay", headers=h).status_code == 409


def test_save_current_as_preset(rig):
    h = rig.login()
    rig.client.put("/thresholds/mature", json=[{"parameter": "ec", "min": 1.6, "max": 2.2}], headers=h)
    r = rig.client.post("/threshold-presets", json={"name": "Petchay, richer feed"}, headers=h)
    assert r.status_code == 201
    assert r.json()["bands"]["mature"]["ec"]["min"] == 1.6
    assert r.json()["bands"]["growth"]["ec"]["min"] == 1.2


def test_apply_writes_all_three_stages(rig):
    h = rig.login()
    pid = rig.client.post("/threshold-presets", json={"name": "Lettuce", "bands": lettuce(rig)}, headers=h).json()["id"]
    r = rig.client.post(f"/threshold-presets/{pid}/apply", headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["active"] == {"id": pid, "name": "Lettuce", "modified": False}
    assert r.json()["changed"] == 6                      # 2 parameters x 3 stages differ from petchay
    for stage in ("seedling", "growth", "mature"):
        thr = {t["parameter"]: t for t in rig.client.get(f"/thresholds/{stage}", headers=h).json()}
        assert (thr["soil_moisture"]["min"], thr["soil_moisture"]["max"], thr["soil_moisture"]["deadband"]) == (65, 85, 4)
        assert thr["temperature"]["max"] == 24 and thr["soil_moisture"]["version"] == 2
        assert thr["ph"]["version"] == 1                 # unchanged rows are not rewritten
    # the control loop picks it up straight away (active stage is seedling after seeding)
    assert rig.control.engine.bands["soil_moisture"].lo == 65
    audit = rig.client.get("/logs?kind=audit", headers=h).json()
    applied = next(a for a in audit if a["action"] == "preset_applied")
    assert applied["target"] == f"preset:{pid}" and applied["detail"]["previous"] == "Petchay (default)"
    # back to petchay
    r = rig.client.post("/threshold-presets/petchay/apply", headers=h).json()
    assert r["active"]["id"] == "petchay" and r["changed"] == 6
    assert rig.control.engine.bands["soil_moisture"].lo == 70


def test_editing_a_band_marks_the_preset_modified(rig):
    h = rig.login()
    rig.client.put("/thresholds/growth", json=[{"parameter": "humidity", "min": 62, "max": 80}], headers=h)
    assert rig.client.get("/threshold-presets", headers=h).json()["active"]["modified"] is True
    rig.client.put("/thresholds/growth", json=[{"parameter": "humidity", "min": 60, "max": 80}], headers=h)
    assert rig.client.get("/threshold-presets", headers=h).json()["active"]["modified"] is False   # back to the preset


def test_deleting_the_active_preset_keeps_thresholds(rig):
    h = rig.login()
    pid = rig.client.post("/threshold-presets", json={"name": "Lettuce", "bands": lettuce(rig)}, headers=h).json()["id"]
    rig.client.post(f"/threshold-presets/{pid}/apply", headers=h)
    rig.client.delete(f"/threshold-presets/{pid}", headers=h)
    assert rig.client.get("/threshold-presets", headers=h).json()["active"] is None
    thr = {t["parameter"]: t for t in rig.client.get("/thresholds/growth", headers=h).json()}
    assert thr["soil_moisture"]["min"] == 65


@pytest.mark.parametrize("mutate, msg", [
    (lambda b: b.pop("mature"), "mature: missing"),
    (lambda b: b["growth"].pop("ph"), "growth ph: missing"),
    (lambda b: b["growth"]["ph"].update(min=7, max=6), "min must be below max"),
    (lambda b: b["seedling"]["humidity"].update(max=120), "within"),
    (lambda b: b["seedling"]["co2"].update(deadband=-1), "deadband"),
    (lambda b: b.update(flowering={}), "unknown stage"),
])
def test_invalid_presets_are_refused(rig, mutate, msg):
    h = rig.login()
    b = lettuce(rig)
    mutate(b)
    r = rig.client.post("/threshold-presets", json={"name": "Bad", "bands": b}, headers=h)
    assert r.status_code == 422 and msg in r.text


def test_viewer_and_cloud_cannot_write(tmp_path, rig):
    v = rig.login("viewer@test.ph")
    assert rig.client.get("/threshold-presets", headers=v).status_code == 200
    assert rig.client.post("/threshold-presets", json={"name": "X"}, headers=v).status_code == 403
    assert rig.client.post("/threshold-presets/petchay/apply", headers=v).status_code == 403
    cloud = Rig(tmp_path, role="cloud")
    h = cloud.login()
    assert cloud.client.post("/threshold-presets", json={"name": "X"}, headers=h).status_code == 409
    assert cloud.client.post("/threshold-presets/petchay/apply", headers=h).status_code == 409


def test_presets_sync_to_cloud(tmp_path, rig):
    from greenhouse.services.sync import SyncService
    h = rig.login()
    pid = rig.client.post("/threshold-presets", json={"name": "Lettuce", "bands": lettuce(rig)}, headers=h).json()["id"]
    rig.client.post(f"/threshold-presets/{pid}/apply", headers=h)
    cloud = Rig(tmp_path, role="cloud")

    def post(table, rows):
        assert cloud.client.post("/sync/ingest", json={"table": table, "rows": rows},
                                 headers={"Authorization": "Bearer sync-tok"}).status_code == 200
    SyncService(rig.db, "http://cloud", "sync-tok", post=post).sync_once()
    r = cloud.client.get("/threshold-presets", headers=cloud.login()).json()
    assert r["active"]["name"] == "Lettuce"
    assert {p["name"] for p in r["presets"]} == {"Petchay (default)", "Lettuce"}
    rig.client.delete(f"/threshold-presets/{pid}", headers=h)
    SyncService(rig.db, "http://cloud", "sync-tok", post=post).sync_once()
    r = cloud.client.get("/threshold-presets", headers=cloud.login()).json()
    assert [p["name"] for p in r["presets"]] == ["Petchay (default)"] and r["active"] is None


def test_saving_edited_thresholds_makes_the_new_preset_active(rig):
    h = rig.login()
    rig.client.put("/thresholds/growth", json=[{"parameter": "humidity", "min": 62, "max": 80}], headers=h)
    pid = rig.client.post("/threshold-presets", json={"name": "Petchay, drier"}, headers=h).json()["id"]
    assert rig.client.get("/threshold-presets", headers=h).json()["active"] == {"id": pid, "name": "Petchay, drier", "modified": False}
    # saving again while unmodified keeps the active one
    rig.client.post("/threshold-presets", json={"name": "Copy"}, headers=h)
    assert rig.client.get("/threshold-presets", headers=h).json()["active"]["id"] == pid
