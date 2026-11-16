"""Power cuts and supply dips, logged automatically (added 17 Nov 2026).

The Pi has no battery, so a power cut simply stops it; it cannot write anything at that moment.
Each cut is therefore worked out afterwards, from the system journal (kept on the SD card since
3 Nov 2026), once the clock is trusted (greenhouse.clock):

* Every start of the Pi is a "boot" in the journal. A boot that ended with a proper shutdown has
  "Journal stopped" or "Reached target System Reboot/Power Off" among its last lines; one that just
  stops was a power cut (or a crash or a pulled plug: from the Pi's side these look the same).
* When the power went: the later of the last journal line of the boot that stopped and the last
  reading stored in the database before the next start. The journal writes to the card every few
  minutes and readings arrive every 30-60 s, so this is the last moment the Pi was surely on.
* When it came back: the start of the next boot. A boot's start is its realtime minus its monotonic
  time, taken from a journal line written after the clock was set by NTP (the Pi has no battery
  clock until B6, so earlier lines carry a wrong time). For the boot that is running now it is
  simply now minus the uptime. The Pi starts a few seconds after the power returns.

Brief dips that do not restart the Pi are caught by the firmware's under-voltage flag
(hwmon "rpi_volt", in0_lcrit_alarm; else `vcgencmd get_throttled` bit 0), polled every 2 s.

Each event is a row in power_events (one per boot for cuts and restarts, so a rescan never adds
it twice). A cut or a dip ending in the last 48 hours also raises an alert (POWER_OUTAGE,
UNDERVOLTAGE). A planned restart is recorded without an alert. `greenhouse power list` and
GET /power-events show the history; `greenhouse power scan` reruns the scan by hand.
"""
from __future__ import annotations

import json
import re
import logging
import subprocess
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable

from sqlalchemy import func, select

from .control.types import AlertSignal
from .db import Database
from .models import PowerEvent, SensorReading
from .timeutil import local_time_of, utcnow

log = logging.getLogger(__name__)

ALERT_WINDOW = timedelta(hours=48)     # older events found by a scan are recorded without an alert
CLEAN_MARKERS = ("Journal stopped", "Reached target System Reboot", "Reached target System Power Off",
                 "Reached target System Halt", "Reached target reboot.target", "Reached target poweroff.target",
                 "systemd-shutdown")
SYNC_MARKERS = ("Initial clock synchronization", "Contacted time server", "Synchronized to time server")
UNDERVOLT_MARKERS = ("Undervoltage detected", "under-voltage", "Under-voltage")


@dataclass
class Boot:
    boot_id: str
    index: int
    last_rt: datetime | None = None        # realtime of the last line (naive UTC); None if never synced
    start_rt: datetime | None = None       # realtime of the boot's start; None if never synced
    clean: bool = False                    # ended with a proper shutdown
    undervolt: bool = False                # under-voltage logged among the last lines
    current: bool = False


@dataclass
class Found:
    kind: str                              # outage | restart
    boot_id: str                           # the boot that started after it
    started_at: datetime | None
    ended_at: datetime | None
    detail: dict = field(default_factory=dict)

    @property
    def duration_s(self) -> float | None:
        if self.started_at and self.ended_at:
            return max(0.0, (self.ended_at - self.started_at).total_seconds())
        return None


def _us(v) -> datetime:
    return datetime(1970, 1, 1) + timedelta(microseconds=int(v))


def fmt_duration(s: float | None) -> str:
    if s is None:
        return "unknown"
    s = int(round(s))
    if s < 60:
        return f"{s} s"
    if s < 3600:
        return f"{s // 60} min {s % 60} s" if s % 60 else f"{s // 60} min"
    return f"{s // 3600} h {(s % 3600) // 60} min"


def _hm(dt: datetime | None, seconds: bool = True) -> str:
    if dt is None:
        return "?"
    return local_time_of(dt).strftime("%H:%M:%S" if seconds else "%H:%M")


def _day(dt: datetime | None) -> str:
    return local_time_of(dt).strftime("%-d %b") if dt else "?"


class Journal:
    """Reads boots from journalctl (JSON output). `run` is injectable for tests."""

    def __init__(self, run: Callable = subprocess.run):
        self._run = run

    def _json_lines(self, args: list[str]) -> list[dict]:
        r = self._run(["journalctl", "--no-pager", *args], capture_output=True, text=True, timeout=30)
        out = []
        for line in (r.stdout or "").splitlines():
            line = line.strip()
            if line.startswith("{"):
                try:
                    out.append(json.loads(line))
                except ValueError:
                    pass
        return out

    def list_boots(self) -> list[dict]:
        r = self._run(["journalctl", "--no-pager", "--list-boots", "-o", "json"],
                      capture_output=True, text=True, timeout=30)
        text = (r.stdout or "").strip()
        if not text:
            return []
        try:
            data = json.loads(text)
        except ValueError:   # older systemd: plain text, "-1 0a1b…32 hex… Mon 2026-11-16 …"
            r = self._run(["journalctl", "--no-pager", "--list-boots"], capture_output=True, text=True, timeout=30)
            data = []
            for ln in (r.stdout or "").splitlines():
                m = re.match(r"\s*(-?\d+)\s+([0-9a-f]{32})\b", ln)
                if m:
                    data.append({"index": int(m.group(1)), "boot_id": m.group(2)})
        return sorted(data, key=lambda b: int(b.get("index", 0)))

    def last_lines(self, boot_id: str, n: int = 60) -> list[dict]:
        return self._json_lines(["-b", boot_id, "-n", str(n), "-o", "json", "--output-fields=MESSAGE"])

    def sync_lines(self, boot_id: str) -> list[dict]:
        return self._json_lines(["-b", boot_id, "-u", "systemd-timesyncd", "-o", "json",
                                 "--output-fields=MESSAGE"])

    def boots(self) -> list[Boot]:
        out = []
        listed = self.list_boots()
        for i, b in enumerate(listed):
            bid = str(b.get("boot_id", "")).replace("-", "")
            boot = Boot(bid, int(b.get("index", 0)), current=(i == len(listed) - 1))
            sync_m = None
            for e in self.sync_lines(bid):
                msg = str(e.get("MESSAGE", ""))
                if any(k in msg for k in SYNC_MARKERS):
                    sync_m = int(e["__MONOTONIC_TIMESTAMP"])
                    break
            lines = self.last_lines(bid)
            msgs = [str(e.get("MESSAGE", "")) for e in lines]
            boot.clean = any(k in m for m in msgs for k in CLEAN_MARKERS)
            boot.undervolt = any(k in m for m in msgs for k in UNDERVOLT_MARKERS)
            # The boot's last line comes after NTP set the clock, so its realtime is right; the boot's
            # start is that minus its monotonic time. (The sync line itself may be logged just before
            # the clock is stepped, so it is only used as proof that a sync happened.)
            if lines and sync_m is not None and int(lines[-1]["__MONOTONIC_TIMESTAMP"]) >= sync_m:
                last_m = int(lines[-1]["__MONOTONIC_TIMESTAMP"])
                boot.last_rt = _us(lines[-1]["__REALTIME_TIMESTAMP"])
                boot.start_rt = boot.last_rt - timedelta(microseconds=last_m)
            out.append(boot)
        return out


def find_events(boots: list[Boot], last_reading_before: Callable[[datetime], datetime | None],
                current_start: datetime | None = None) -> list[Found]:
    """One event for each boot that follows another: a cut if the earlier one stopped without a
    shutdown, a restart if it shut down properly."""
    found = []
    for prev, cur in zip(boots, boots[1:]):
        back = current_start if (cur.current and current_start) else cur.start_rt
        detail: dict = {"boot": cur.boot_id, "previous_boot": prev.boot_id}
        lost = prev.last_rt
        if back is not None:
            r = last_reading_before(back)
            # Only a reading from the boot that stopped counts (raw readings older than 7 days are rolled up,
            # so an old boot may have none left and the latest one before it would mislead).
            if r is not None and (r < prev.start_rt if prev.start_rt else back - r > timedelta(days=1)):
                r = None
            if r is not None and (lost is None or r > lost):
                lost, detail["start_from"] = r, "last stored reading"
            elif lost is not None:
                detail["start_from"] = "last journal line"
        if lost is not None and back is not None and lost > back:   # a wrong clock somewhere: do not guess
            lost = None
        if lost is None:
            detail["start_from"] = "unknown (no synced clock before the cut)"
        if back is None:
            detail["end_from"] = "unknown (the clock was never set by NTP in the next boot)"
        else:
            detail["end_from"] = "Pi start (now minus uptime)" if cur.current and current_start else "Pi start (journal)"
        if prev.undervolt:
            detail["undervoltage_before"] = True
        found.append(Found("restart" if prev.clean else "outage", cur.boot_id, lost, back, detail))
    return found


def outage_message(f: Found) -> str:
    d = fmt_duration(f.duration_s)
    if f.kind == "restart":
        return f"The controller was shut down and restarted: off from {_hm(f.started_at)} to {_hm(f.ended_at)} ({d})."
    tail = " Under-voltage was logged just before." if f.detail.get("undervoltage_before") else ""
    if f.started_at and f.ended_at:
        return (f"Power cut on {_day(f.ended_at)}: the controller was off from about {_hm(f.started_at)} "
                f"to {_hm(f.ended_at)} (about {d}) and restarted by itself.{tail}")
    return (f"Power cut on {_day(f.ended_at or f.started_at)}: the controller restarted without a shutdown "
            f"(back by {_hm(f.ended_at)}); when the power went is not known.{tail}")


class UnderVoltage:
    """The firmware's under-voltage flag: True while the supply is below about 4.63 V."""

    def __init__(self, root: Path | str = "/", run: Callable = subprocess.run):
        self.root, self._run = Path(root), run
        self.path: Path | None = None
        self.source = "none"
        for d in sorted((self.root / "sys" / "class" / "hwmon").glob("hwmon*")):
            try:
                if (d / "name").read_text().strip() == "rpi_volt" and (d / "in0_lcrit_alarm").exists():
                    self.path, self.source = d / "in0_lcrit_alarm", f"hwmon {d.name} (rpi_volt)"
                    break
            except OSError:
                continue
        if self.path is None and self._vcgencmd() is not None:
            self.source = "vcgencmd get_throttled"

    def _vcgencmd(self) -> bool | None:
        try:
            r = self._run(["vcgencmd", "get_throttled"], capture_output=True, text=True, timeout=3)
            v = (r.stdout or "").strip().split("=")[-1]
            return bool(int(v, 16) & 0x1)
        except Exception:
            return None

    def now(self) -> bool | None:
        if self.path is not None:
            try:
                return self.path.read_text().strip() == "1"
            except OSError:
                return None
        if self.source.startswith("vcgencmd"):
            return self._vcgencmd()
        return None


class PowerMonitor:
    def __init__(self, db: Database, alerts, clock, journal: Journal | None = None,
                 undervolt: UnderVoltage | None = None, uptime: Callable[[], float] | None = None,
                 now: Callable[[], datetime] = utcnow, mono: Callable[[], float] = time.monotonic,
                 poll_s: float = 2.0):
        self.db, self.alerts, self.clock = db, alerts, clock
        self.journal = journal or Journal()
        self.uv = undervolt if undervolt is not None else UnderVoltage()
        self._uptime = uptime or _read_uptime
        self._now, self._mono, self.poll_s = now, mono, poll_s
        self._scanned = False
        self._uv_since: tuple[datetime, float, bool] | None = None   # (start, mono, clock trusted then)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        try:
            PowerEvent.__table__.create(db.engine, checkfirst=True)   # in case init-db was not rerun
        except Exception:
            log.exception("could not create power_events")

    # ── lifecycle ────────────────────────────────────────────────────────
    def start(self) -> None:
        log.info("power monitor: under-voltage source %s", self.uv.source)
        self._thread = threading.Thread(target=self._loop, name="power", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception:
                log.exception("power monitor failed")
            self._stop.wait(self.poll_s)

    def tick(self) -> None:
        if not self._scanned and self.clock.trusted():
            self._scanned = True
            self.scan()
        self.check_undervoltage()

    # ── power cuts and restarts, from the journal ─────────────────────────
    def last_reading_before(self, t: datetime) -> datetime | None:
        with self.db.session() as s:
            ids = [r[0] for r in s.execute(select(SensorReading.sensor_id).distinct()).all()]
            best = None
            for sid in ids:
                v = s.execute(select(func.max(SensorReading.recorded_at))
                              .where(SensorReading.sensor_id == sid, SensorReading.recorded_at < t)).scalar()
                if v is not None and (best is None or v > best):
                    best = v
            return best

    def scan(self) -> list[PowerEvent]:
        """Record every cut and restart in the journal that is not recorded yet."""
        try:
            boots = self.journal.boots()
        except Exception as e:
            log.warning("power monitor: cannot read the journal (%s); is the service in group systemd-journal?", e)
            return []
        now = self._now()
        current_start = now - timedelta(seconds=self._uptime())
        found = find_events(boots, self.last_reading_before, current_start)
        new: list[PowerEvent] = []
        with self.db.session() as s:
            have = {r[0] for r in s.execute(select(PowerEvent.boot_id).where(PowerEvent.boot_id.is_not(None))).all()}
            for f in found:
                if f.boot_id in have:
                    continue
                ev = PowerEvent(kind=f.kind, boot_id=f.boot_id, started_at=f.started_at, ended_at=f.ended_at,
                                duration_s=f.duration_s, message=outage_message(f)[:255], detail=f.detail,
                                recorded_at=now)
                s.add(ev)
                new.append(ev)
        signals = []
        for ev in new:
            log.info("power: %s", ev.message)
            when = ev.ended_at or ev.started_at
            if ev.kind == "outage" and when is not None and now - when <= ALERT_WINDOW:
                signals.append(AlertSignal(f"outage:{ev.boot_id}", "medium", "power", "POWER_OUTAGE", ev.message, "event"))
        if signals and self.alerts is not None:
            self.alerts.sync(signals, now)
        return new

    # ── brief dips, from the under-voltage flag ───────────────────────────
    def check_undervoltage(self) -> PowerEvent | None:
        v = self.uv.now()
        if v is None:
            return None
        if v and self._uv_since is None:
            self._uv_since = (self._now(), self._mono(), self.clock.trusted())
            log.warning("power: under-voltage now")
            return None
        if not v and self._uv_since is not None:
            start, m0, trusted = self._uv_since
            self._uv_since = None
            secs = self._mono() - m0
            end = start + timedelta(seconds=secs)
            msg = (f"Supply voltage dipped (under-voltage) for {fmt_duration(max(secs, 1))} at {_hm(start)} on "
                   f"{_day(start)}; the controller kept running.")
            if not trusted:
                msg = msg.replace(" at ", " at about ", 1) + " (time not exact: clock not yet set)"
            ev = PowerEvent(kind="undervoltage", boot_id=None, started_at=start, ended_at=end, duration_s=secs,
                            message=msg[:255], detail={"source": self.uv.source, "clock_trusted": trusted},
                            recorded_at=self._now())
            with self.db.session() as s:
                s.add(ev)
            log.warning("power: %s", msg)
            if self.alerts is not None:
                self.alerts.sync([AlertSignal(f"undervoltage:{start.isoformat()}", "medium", "power", "UNDERVOLTAGE",
                                              msg[:255], "event")], self._now())
            return ev
        return None


def _read_uptime() -> float:
    return float(Path("/proc/uptime").read_text().split()[0])


def list_events(db: Database, days: int = 30) -> list[PowerEvent]:
    since = utcnow() - timedelta(days=days)
    with db.session() as s:
        PowerEvent.__table__.create(db.engine, checkfirst=True)
        return list(s.execute(select(PowerEvent)
                              .where(func.coalesce(PowerEvent.ended_at, PowerEvent.started_at, PowerEvent.recorded_at) >= since)
                              .order_by(func.coalesce(PowerEvent.ended_at, PowerEvent.started_at, PowerEvent.recorded_at)))
                    .scalars().all())
