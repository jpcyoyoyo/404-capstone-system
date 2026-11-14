"""Clock check (greenhouse.clock) and held readings in greenhouse-sensors (9 Nov 2026)."""
from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace

from sqlalchemy import select

from greenhouse.clock import FLOOR_EPOCH, ClockCheck
from greenhouse.hal import RawSample
from greenhouse.models import SensorReading
from greenhouse.timeutil import utcnow

from .test_api import Rig

NOW = FLOOR_EPOCH + 9 * 86400   # 10 Nov 2026


def no_ntp(*a, **k):
    return SimpleNamespace(stdout="no\n")


def make_rtc(root, n, epoch, name="rtc-ds1307 1-0068"):
    d = root / "sys" / "class" / "rtc" / f"rtc{n}"
    d.mkdir(parents=True)
    (d / "since_epoch").write_text(f"{epoch}\n")
    (d / "name").write_text(f"{name}\n")


def check(root, run=no_ntp, now=NOW, enabled=True):
    return ClockCheck(enabled, root=root, run=run, now=lambda: now, mono=lambda: 0.0, recheck_s=0)


# ── ClockCheck ───────────────────────────────────────────────────────────
def test_timesyncd_flag_is_trusted(tmp_path):
    (tmp_path / "run" / "systemd" / "timesync").mkdir(parents=True)
    (tmp_path / "run" / "systemd" / "timesync" / "synchronized").touch()
    c = check(tmp_path)
    assert c.trusted() and "timesyncd" in c.reason


def test_timedatectl_yes_is_trusted(tmp_path):
    c = check(tmp_path, run=lambda *a, **k: SimpleNamespace(stdout="yes\n"))
    assert c.trusted() and "timedatectl" in c.reason


def test_no_ntp_and_no_rtc_is_not_trusted(tmp_path):
    c = check(tmp_path)
    assert not c.trusted()
    assert "no NTP" in c.reason


def test_timedatectl_missing_falls_back_to_rtc(tmp_path):
    def boom(*a, **k):
        raise FileNotFoundError("timedatectl")
    make_rtc(tmp_path, 1, NOW + 2)
    assert check(tmp_path, run=boom).trusted()


def test_rtc_agreeing_with_system_clock_is_trusted(tmp_path):
    make_rtc(tmp_path, 0, 0, name="rpi-rtc soc:rpi_rtc")   # Pi 5 RTC without its battery
    make_rtc(tmp_path, 1, NOW - 3)                        # DS3231 with its cell
    c = check(tmp_path)
    assert c.trusted() and "rtc1" in c.reason


def test_rtc_that_lost_power_is_not_trusted(tmp_path):
    make_rtc(tmp_path, 0, 946684800)   # 1 Jan 2000: DS3231 reset without a cell
    assert not check(tmp_path, now=946684800).trusted()


def test_rtc_disagreeing_with_system_clock_is_not_trusted(tmp_path):
    make_rtc(tmp_path, 1, NOW - 3600)
    assert not check(tmp_path).trusted()


def test_system_clock_before_floor_is_not_trusted(tmp_path):
    make_rtc(tmp_path, 1, FLOOR_EPOCH - 86400)
    c = check(tmp_path, now=FLOOR_EPOCH - 86400)
    assert not c.trusted() and "before" in c.reason


def test_check_off_is_trusted(tmp_path):
    assert check(tmp_path, enabled=False).trusted()


def test_trusted_stays_trusted(tmp_path):
    flag = tmp_path / "run" / "systemd" / "timesync"
    flag.mkdir(parents=True)
    (flag / "synchronized").touch()
    c = check(tmp_path)
    assert c.trusted()
    (flag / "synchronized").unlink()
    assert c.trusted()


def test_untrusted_rechecks_at_most_every_recheck_s(tmp_path):
    calls, t = [], [0.0]

    def run(*a, **k):
        calls.append(1)
        return SimpleNamespace(stdout="no\n")
    c = ClockCheck(True, root=tmp_path, run=run, now=lambda: NOW, mono=lambda: t[0], recheck_s=10)
    c.trusted(); c.trusted()
    t[0] = 5.0; c.trusted()
    t[0] = 10.5; c.trusted()
    assert len(calls) == 2


# ── greenhouse-sensors holding readings ─────────────────────────────────
class FakeClock:
    reason = "test"

    def __init__(self, ok=False):
        self.ok = ok

    def trusted(self):
        return self.ok


def rig_with(tmp_path, clock, mono, max_held=50_000):
    from greenhouse.services.sensors import SensorService
    r = Rig(tmp_path)
    r.sensors = SensorService(r.reg, r.db, r.bus, r.hal, clock=clock, mono=lambda: mono[0], max_held=max_held)
    return r


def co2_rows(r):
    with r.db.session() as s:
        return s.execute(select(SensorReading).where(SensorReading.sensor_id == "co2_01")
                         .order_by(SensorReading.recorded_at)).scalars().all()


def test_untrusted_clock_publishes_but_does_not_store(tmp_path):
    mono = [1000.0]
    r = rig_with(tmp_path, FakeClock(False), mono)
    before = len(r.bus.published)
    out = r.sensors.ingest([RawSample("co2_01", 410.0, True)])
    assert out and len(r.bus.published) > before   # still live on the kiosk and to the controller
    assert co2_rows(r) == []
    assert r.sensors.held_count() == 1


def test_held_readings_stored_with_times_from_trusted_clock(tmp_path):
    mono, clock = [1000.0], FakeClock(False)
    r = rig_with(tmp_path, clock, mono)
    r.sensors.ingest([RawSample("co2_01", 410.0, True)])   # taken at mono 1000
    mono[0] = 1600.0
    r.sensors.ingest([RawSample("co2_01", 420.0, True)])   # taken at mono 1600
    mono[0] = 1900.0
    clock.ok = True
    t_flush = utcnow()
    assert r.sensors.flush_held() == 2
    rows = co2_rows(r)
    assert [x.raw for x in rows] == [410.0, 420.0]
    age = [(t_flush - x.recorded_at).total_seconds() for x in rows]
    assert abs(age[0] - 900) < 5 and abs(age[1] - 300) < 5
    assert r.sensors.held_count() == 0


def test_next_ingest_after_trust_flushes_first(tmp_path):
    mono, clock = [0.0], FakeClock(False)
    r = rig_with(tmp_path, clock, mono)
    r.sensors.ingest([RawSample("co2_01", 410.0, True)])
    mono[0] = 60.0
    clock.ok = True
    r.sensors.ingest([RawSample("co2_01", 415.0, True)])
    assert [x.raw for x in co2_rows(r)] == [410.0, 415.0]


def test_held_buffer_drops_oldest_when_full(tmp_path):
    mono, clock = [0.0], FakeClock(False)
    r = rig_with(tmp_path, clock, mono, max_held=3)
    for i, v in enumerate([401.0, 402.0, 403.0, 404.0, 405.0]):
        mono[0] = i * 60.0
        r.sensors.ingest([RawSample("co2_01", v, True)])
    assert r.sensors.held_count() == 3
    clock.ok = True
    r.sensors.flush_held()
    assert [x.raw for x in co2_rows(r)] == [403.0, 404.0, 405.0]


def test_retention_skipped_while_clock_untrusted(tmp_path):
    mono, clock = [0.0], FakeClock(False)
    r = rig_with(tmp_path, clock, mono)
    with r.db.session() as s:
        s.add(SensorReading(sensor_id="co2_01", value=400.0, raw=400.0, unit="ppm", quality="VALID",
                            recorded_at=utcnow() - timedelta(days=30)))
    assert r.sensors.run_retention() == 0
    assert len(co2_rows(r)) == 1
    clock.ok = True
    assert r.sensors.run_retention() == 1


def test_co2_warmup_uses_monotonic_time(tmp_path):
    mono, clock = [0.0], FakeClock(True)
    r = rig_with(tmp_path, clock, mono)
    # 60 s after start on the monotonic clock: still warming, whatever the wall clock says.
    mono[0] = 60.0
    out = r.sensors.ingest([RawSample("co2_01", 410.0, True)], ts=utcnow() + timedelta(days=2))
    assert out[0]["quality"] == "WARMING"
    mono[0] = 200.0
    out = r.sensors.ingest([RawSample("co2_01", 410.0, True)])
    assert out[0]["quality"] == "VALID"


def test_full_scale_co2_stored_invalid_with_raw_kept(tmp_path):
    mono = [600.0]
    r = rig_with(tmp_path, FakeClock(True), mono)
    out = r.sensors.ingest([RawSample("co2_01", 5000.0, True)])
    assert out[0]["quality"] == "INVALID" and out[0]["value"] is None
    row = co2_rows(r)[-1]
    assert (row.quality, row.value, row.raw) == ("INVALID", None, 5000.0)
