"""Power cuts from the journal, and supply dips from the under-voltage flag (greenhouse/power.py)."""
import json
from datetime import datetime, timedelta
from types import SimpleNamespace

from greenhouse.bus import Topics
from greenhouse.db import Database
from greenhouse.models import Alert, PowerEvent, SensorReading
from greenhouse.power import Boot, Journal, PowerMonitor, find_events, fmt_duration
from greenhouse.services.common import AlertManager

EPOCH = datetime(1970, 1, 1)
NOW = datetime(2026, 11, 16, 22, 0, 0)          # 06:00 on 17 Nov in Manila


def us(dt):
    return str(int((dt - EPOCH).total_seconds() * 1_000_000))


def line(msg, rt, mono_s):
    return json.dumps({"MESSAGE": msg, "__REALTIME_TIMESTAMP": us(rt), "__MONOTONIC_TIMESTAMP": str(int(mono_s * 1e6))})


class FakeJournalctl:
    """Three boots: B1 ends in a power cut (under-voltage logged), B2 shuts down properly, B3 is running."""

    def __init__(self):
        self.b1_start = NOW - timedelta(hours=5)
        self.b1_last = self.b1_start + timedelta(minutes=40)          # last line before the cut
        self.b2_start = self.b1_last + timedelta(minutes=3)           # power back 3 min later
        self.b2_last = self.b2_start + timedelta(hours=1)
        wrong = datetime(2026, 11, 2)                                 # before NTP the clock is wrong
        self.boots = [{"index": -2, "boot_id": "b1" * 16}, {"index": -1, "boot_id": "b2" * 16},
                      {"index": 0, "boot_id": "b3" * 16}]
        self.sync = {"b1" * 16: [line("Initial clock synchronization to Mon 2026-11-16.", self.b1_start + timedelta(seconds=40), 40)],
                     "b2" * 16: [line("Contacted time server 1.2.3.4:123 (2.debian.pool.ntp.org).", self.b2_start + timedelta(seconds=35), 35)],
                     "b3" * 16: []}
        self.last = {"b1" * 16: [line("starting", wrong, 2),
                                 line("hwmon hwmon1: Undervoltage detected!", self.b1_last - timedelta(seconds=5), 2395),
                                 line("ALERT", self.b1_last, 2400)],
                     "b2" * 16: [line("Stopping greenhouse-sensors", self.b2_last - timedelta(seconds=2), 3598),
                                 line("Journal stopped", self.b2_last, 3600)],
                     "b3" * 16: [line("now", NOW, 100)]}

    def __call__(self, args, **kw):
        if "--list-boots" in args:
            out = json.dumps(self.boots)
        else:
            bid = args[args.index("-b") + 1]
            out = "\n".join(self.sync[bid] if "-u" in args else self.last[bid])
        return SimpleNamespace(stdout=out, returncode=0)


class Bus:
    def __init__(self):
        self.sent = []

    def publish(self, topic, payload, **kw):
        self.sent.append((topic, payload))


class Clock:
    def __init__(self, ok=True):
        self.ok = ok

    def trusted(self):
        return self.ok


class UV:
    source = "test"

    def __init__(self):
        self.v = False

    def now(self):
        return self.v


def make(tmp_path, fake=None, now=NOW, uptime=600.0, uv=None):
    db = Database(f"sqlite:///{tmp_path}/p.db")
    db.create_all()
    bus = Bus()
    alerts = AlertManager(db, bus, Topics("gh-test"), owner="power")
    clock = {"t": 0.0}
    mon = PowerMonitor(db, alerts, Clock(), journal=Journal(fake or FakeJournalctl()), undervolt=uv or UV(),
                       uptime=lambda: uptime, now=lambda: now, mono=lambda: clock["t"])
    return db, bus, mon, clock


def test_journal_boots_are_read(tmp_path):
    fake = FakeJournalctl()
    boots = Journal(fake).boots()
    assert [b.clean for b in boots] == [False, True, False]
    assert boots[0].undervolt and not boots[1].undervolt
    assert abs((boots[1].start_rt - fake.b2_start).total_seconds()) < 1
    assert boots[0].last_rt == fake.b1_last.replace(microsecond=0) or abs((boots[0].last_rt - fake.b1_last).total_seconds()) < 1
    assert boots[2].current


def test_scan_records_cut_and_restart_once(tmp_path):
    fake = FakeJournalctl()
    db, bus, mon, _ = make(tmp_path, fake)
    new = mon.scan()
    kinds = [e.kind for e in new]
    assert kinds == ["outage", "restart"]
    cut = new[0]
    assert abs(cut.duration_s - 180) < 2
    assert "Power cut on 17 Nov" in cut.message and "about 3 min" in cut.message and "Under-voltage" in cut.message
    restart = new[1]
    assert abs((restart.ended_at - (NOW - timedelta(seconds=600))).total_seconds()) < 1   # current boot: now minus uptime
    with db.session() as s:
        alerts = s.query(Alert).all()
    assert [a.code for a in alerts] == ["POWER_OUTAGE"]        # a planned restart raises no alert
    assert mon.scan() == []                                   # nothing added twice
    with db.session() as s:
        assert s.query(PowerEvent).count() == 2


def test_last_reading_moves_the_start_later(tmp_path):
    fake = FakeJournalctl()
    db, _, mon, _ = make(tmp_path, fake)
    later = fake.b1_last + timedelta(seconds=150)   # a reading after the journal's last line (journal writes lag)
    with db.session() as s:
        s.add(SensorReading(sensor_id="co2_01", value=600, raw=600, unit="ppm", quality="VALID", recorded_at=later))
    cut = mon.scan()[0]
    assert cut.started_at == later and cut.detail["start_from"] == "last stored reading"
    assert abs(cut.duration_s - 30) < 2


def test_old_cut_is_logged_without_alert(tmp_path):
    db, _, mon, _ = make(tmp_path, now=NOW + timedelta(days=5), uptime=600)
    mon.scan()
    with db.session() as s:
        assert s.query(PowerEvent).filter_by(kind="outage").count() == 1
        assert s.query(Alert).count() == 0


def test_unsynced_boots_give_unknown_times():
    b1 = Boot("a", -1)                      # never synced: no last time
    b2 = Boot("b", 0, current=True)
    f = find_events([b1, b2], lambda t: None, current_start=NOW)[0]
    assert f.kind == "outage" and f.started_at is None and f.ended_at == NOW and f.duration_s is None


def test_old_reading_from_an_earlier_boot_is_ignored():
    b1 = Boot("a", -1, start_rt=NOW - timedelta(hours=2))
    b2 = Boot("b", 0, current=True)
    f = find_events([b1, b2], lambda t: NOW - timedelta(hours=3), current_start=NOW)[0]
    assert f.started_at is None


def test_undervoltage_dip_is_logged(tmp_path):
    uv = UV()
    db, bus, mon, clock = make(tmp_path, uv=uv)
    mon._scanned = True
    uv.v = True
    assert mon.check_undervoltage() is None
    clock["t"] += 3.0
    uv.v = False
    ev = mon.check_undervoltage()
    assert ev.kind == "undervoltage" and abs(ev.duration_s - 3.0) < 0.01
    assert "for 3 s" in ev.message and "kept running" in ev.message
    with db.session() as s:
        assert [a.code for a in s.query(Alert).all()] == ["UNDERVOLTAGE"]


def test_fmt_duration():
    assert fmt_duration(42) == "42 s"
    assert fmt_duration(180) == "3 min"
    assert fmt_duration(185) == "3 min 5 s"
    assert fmt_duration(3725) == "1 h 2 min"
    assert fmt_duration(None) == "unknown"
