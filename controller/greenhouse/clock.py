"""Is the system clock good enough to timestamp stored readings? (added 9 Nov 2026)

Until B6 is finished the Pi has no battery-backed clock (the DS3231's cell is not fitted). After a
power cut without internet it can start at a wrong time, and readings stored before NTP corrects
the clock would carry wrong timestamps. greenhouse-sensors therefore holds readings until this
check passes, then stores them with corrected times (see services/sensors.py).

The clock is trusted when any of these holds:
  1. systemd-timesyncd has synchronised since boot (/run/systemd/timesync/synchronized), or
     `timedatectl show -p NTPSynchronized` says yes;
  2. a hardware clock (/sys/class/rtc/rtc*) reads a time after CLOCK_FLOOR and within
     RTC_AGREE_S of the system clock: the DS3231 with its cell after B6, or the Pi 5's own RTC
     while it has power. A clock that lost power restarts near 1970 or 2000 and fails this.
Once trusted it stays trusted for the life of the process. GH_CLOCK_CHECK=0 turns the check off.
"""
from __future__ import annotations

import logging
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

log = logging.getLogger(__name__)

# Any time before this is certainly wrong (the day this check was written).
CLOCK_FLOOR = datetime(2026, 11, 1, tzinfo=timezone.utc)
FLOOR_EPOCH = int(CLOCK_FLOOR.timestamp())
RTC_AGREE_S = 60


class ClockCheck:
    def __init__(self, enabled: bool = True, *, root: Path | str = "/", recheck_s: float = 10.0,
                 run: Callable = subprocess.run, now: Callable[[], float] = time.time,
                 mono: Callable[[], float] = time.monotonic):
        self.enabled = enabled
        self.root = Path(root)
        self.recheck_s = recheck_s
        self._run, self._now, self._mono = run, now, mono
        self._trusted = not enabled
        self._last_check: float | None = None
        self.reason = "check off (GH_CLOCK_CHECK=0)" if not enabled else "not checked yet"

    def trusted(self) -> bool:
        if self._trusted:
            return True
        m = self._mono()
        if self._last_check is not None and m - self._last_check < self.recheck_s:
            return False
        self._last_check = m
        ok, self.reason = self._check()
        if ok:
            self._trusted = True
            log.info("system clock trusted: %s", self.reason)
        return ok

    def _check(self) -> tuple[bool, str]:
        if (self.root / "run" / "systemd" / "timesync" / "synchronized").exists():
            return True, "NTP (timesyncd)"
        try:
            r = self._run(["timedatectl", "show", "-p", "NTPSynchronized", "--value"],
                          capture_output=True, text=True, timeout=3)
            if (r.stdout or "").strip() == "yes":
                return True, "NTP (timedatectl)"
        except Exception:  # no timedatectl (not systemd) or it timed out: fall through to the RTC
            pass
        now = int(self._now())
        if now < FLOOR_EPOCH:
            return False, "system clock is before 1 Nov 2026"
        for d in sorted((self.root / "sys" / "class" / "rtc").glob("rtc*")):
            try:
                rtc = int((d / "since_epoch").read_text().strip())
            except (OSError, ValueError):
                continue
            try:
                name = (d / "name").read_text().strip()
            except OSError:
                name = "?"
            if rtc >= FLOOR_EPOCH and abs(rtc - now) <= RTC_AGREE_S:
                return True, f"hardware clock {d.name} ({name})"
        return False, "no NTP sync yet and no hardware clock with a valid time"


class AlwaysTrusted:
    """Simulator, tests and the bench: the clock is whatever the host says."""
    enabled = False
    reason = "not checked"

    def trusted(self) -> bool:
        return True
