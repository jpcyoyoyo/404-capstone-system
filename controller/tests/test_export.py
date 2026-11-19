"""Records export (greenhouse/export.py, GET /export), 19 Nov 2026."""
from __future__ import annotations

import csv
import io
import zipfile
from datetime import datetime, timedelta

from greenhouse.models import (ActuatorEvent, Alert, AuditLog, FertigationDose, SensorReading, SensorReading15m)

from .test_api import Rig

# 18 Nov 2026 at the greenhouse (UTC+8): 08:00 local is 00:00 UTC.
DAY = datetime(2026, 11, 18, 0, 0, 0)


def rows(r) -> list[dict]:
    text = r.content.decode("utf-8")
    assert text.startswith("﻿")                      # Excel reads UTF-8 with the mark
    return list(csv.DictReader(io.StringIO(text[1:])))


def get(rig, h, **q):
    q.setdefault("from", "2026-11-18T00:00:00Z")
    q.setdefault("to", "2026-11-19T00:00:00Z")
    return rig.client.get("/export", params=q, headers=h)


def seed(rig):
    with rig.db.session() as s:
        for i, v in enumerate([20.0, 22.0, 24.0, 26.0]):          # 08:00, 08:15, 08:30, 08:45 local
            s.add(SensorReading(sensor_id="temp_z1_01", value=v, raw=v, unit="°C", quality="VALID",
                                recorded_at=DAY + timedelta(minutes=15 * i)))
        s.add(SensorReading(sensor_id="temp_z1_01", value=None, raw=99.0, unit="°C", quality="INVALID",
                            recorded_at=DAY + timedelta(minutes=50)))
        s.add(SensorReading(sensor_id="soil_z1_01", value=40.0, raw=1.2, unit="%", quality="VALID",
                            recorded_at=DAY + timedelta(minutes=5)))
        # an older period kept only as 15-minute averages (raw readings removed)
        s.add(SensorReading15m(sensor_id="temp_z1_01", bucket_start=DAY + timedelta(hours=1), avg_value=30.0,
                               min_value=28.0, max_value=32.0, samples=30))
        # 23:30 local on the 18th and 00:30 local on the 19th: different local days
        s.add(SensorReading(sensor_id="soil_z1_01", value=50.0, raw=1.0, unit="%", quality="VALID",
                            recorded_at=DAY + timedelta(hours=15, minutes=30)))
        s.add(SensorReading(sensor_id="soil_z1_01", value=70.0, raw=0.8, unit="%", quality="VALID",
                            recorded_at=DAY + timedelta(hours=16, minutes=30)))
        s.add(Alert(severity="high", source="level_01", code="LOW_WATER", message="Reservoir at 12 %",
                    dedupe_key="lw", raised_at=DAY + timedelta(hours=2), last_seen_at=DAY + timedelta(hours=2),
                    resolved_at=DAY + timedelta(hours=2, minutes=30)))
        s.add(FertigationDose(target_g=5.0, delivered_g=4.8, status="complete", reason="", source="manual",
                              issued_by="admin@test.ph", started_at=DAY + timedelta(hours=3),
                              finished_at=DAY + timedelta(hours=3, minutes=1)))
        s.add(ActuatorEvent(actuator_id="pump", action="ON", reason="soil dry", source="auto",
                            occurred_at=DAY + timedelta(hours=4)))
        s.add(ActuatorEvent(actuator_id="pump", action="OFF", reason="done", source="auto",
                            occurred_at=DAY + timedelta(hours=4, minutes=2)))
        s.add(AuditLog(actor="=HYPERLINK(\"http://x\")", action="login", target="auth", occurred_at=DAY + timedelta(hours=5)))


def test_raw_readings_as_one_csv(tmp_path):
    rig = Rig(tmp_path); h = rig.login(); seed(rig)
    r = get(rig, h, datasets="readings", sensors="temp_z1_01")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    assert r.headers["content-disposition"] == 'attachment; filename="greenhouse-sensors-raw_2026-11-18_to_2026-11-19.csv"'
    got = rows(r)
    assert [x["value"] for x in got] == ["20.0", "22.0", "24.0", "26.0"]           # VALID only by default
    assert got[0]["time_local"] == "2026-11-18 08:00:00" and got[0]["time_utc"] == "2026-11-18T00:00:00Z"
    assert got[0]["unit"] == "°C" and got[0]["zone"] == "1" and got[0]["type"] == "temperature"
    bad = rows(get(rig, h, datasets="readings", sensors="temp_z1_01", invalid="true"))
    assert [x["quality"] for x in bad][-1] == "INVALID" and bad[-1]["raw"] == "99.0"


def test_hourly_averages_combine_raw_readings_and_kept_averages(tmp_path):
    rig = Rig(tmp_path); h = rig.login(); seed(rig)
    got = rows(get(rig, h, datasets="readings", sensors="temp_z1_01", resolution="1h"))
    assert [(x["time_local"], x["average"], x["min"], x["max"], x["samples"]) for x in got] == [
        ("2026-11-18 08:00:00", "23.0", "20.0", "26.0", "4"),
        ("2026-11-18 09:00:00", "30.0", "28.0", "32.0", "30")]


def test_daily_averages_follow_the_local_day(tmp_path):
    rig = Rig(tmp_path); h = rig.login(); seed(rig)
    got = rows(get(rig, h, datasets="readings", sensors="soil_z1_01", resolution="1d", to="2026-11-19T12:00:00Z"))
    assert [(x["time_local"], x["average"], x["samples"]) for x in got] == [
        ("2026-11-18 00:00:00", "45.0", "2"), ("2026-11-19 00:00:00", "70.0", "1")]


def test_one_column_per_sensor(tmp_path):
    rig = Rig(tmp_path); h = rig.login(); seed(rig)
    got = rows(get(rig, h, datasets="readings", sensors="temp_z1_01,soil_z1_01", resolution="1h", layout="wide"))
    assert list(got[0]) == ["time_local", "time_utc", "temp_z1_01 (°C)", "soil_z1_01 (%)"]
    assert got[0]["temp_z1_01 (°C)"] == "23.0" and got[0]["soil_z1_01 (%)"] == "40.0"
    assert got[1]["soil_z1_01 (%)"] == ""                                          # no reading that hour
    r = get(rig, h, datasets="readings", layout="wide")                             # raw cannot be side by side
    assert r.status_code == 422 and "averages" in r.json()["detail"]


def test_several_records_come_as_a_zip_with_a_readme(tmp_path):
    rig = Rig(tmp_path); h = rig.login(); seed(rig)
    r = get(rig, h, datasets="readings,summary,water,fertilizer,activity,alerts,power", types="temperature", resolution="15m")
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    assert r.headers["content-disposition"] == 'attachment; filename="greenhouse-records_2026-11-18_to_2026-11-19.zip"'
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert sorted(z.namelist()) == ["README.txt", "activity.csv", "alerts.csv", "fertilizer_doses.csv", "power_events.csv",
                                    "sensor_averages.csv", "sensor_summary.csv", "water_use.csv"]
    readme = z.read("README.txt").decode("utf-8-sig")
    assert "alerts.csv — 1 rows" in readme and "Asia/Manila" in readme
    read = lambda n: list(csv.DictReader(io.StringIO(z.read(n).decode("utf-8-sig"))))
    alert = read("alerts.csv")[0]
    assert alert["title"] and alert["open_minutes"] == "30.0" and alert["raised_local"] == "2026-11-18 10:00:00"
    assert read("fertilizer_doses.csv")[0]["error_g"] == "-0.2"
    assert read("water_use.csv")[0] == {"date": "2026-11-18", "litres": "12.0", "pump_minutes": "2.0",
                                        "method": "estimated_from_run_time"}
    summary = {x["sensor_id"]: x for x in read("sensor_summary.csv")}
    assert summary["temp_z1_01"]["readings"] == "35" and summary["temp_z1_01"]["valid"] == "34"
    assert summary["temp_z1_01"]["valid_percent"] == "97.1"
    activity = read("activity.csv")
    assert [a["action"] for a in activity] == ["ON", "OFF", "login"]
    assert activity[-1]["by"].startswith("'=")                                      # not run as a formula


def test_bad_requests_are_refused_in_words(tmp_path):
    rig = Rig(tmp_path); h = rig.login()
    assert get(rig, h, datasets="everything").status_code == 422
    assert get(rig, h, resolution="5m").status_code == 422
    assert get(rig, h, sensors="nope_01").status_code == 422
    assert get(rig, h, **{"from": "2026-11-19T00:00:00Z", "to": "2026-11-18T00:00:00Z"}).status_code == 422
    assert get(rig, h, **{"from": "2025-01-01T00:00:00Z"}).status_code == 422          # over 400 days
    assert rig.client.get("/export").status_code == 401                                # signed in only


def test_viewers_can_export_and_it_is_logged(tmp_path):
    rig = Rig(tmp_path); seed(rig)
    r = get(rig, rig.login("viewer@test.ph"), datasets="alerts")
    assert r.status_code == 200 and len(rows(r)) == 1
    with rig.db.session() as s:
        assert s.query(AuditLog).filter_by(action="export", actor="viewer@test.ph").count() == 1


def test_the_app_can_read_the_file_name(tmp_path):
    rig = Rig(tmp_path); h = rig.login()
    r = rig.client.get("/export", params={"datasets": "alerts"}, headers={**h, "Origin": "https://localhost"})
    assert "content-disposition" in r.headers.get("access-control-expose-headers", "").lower()
