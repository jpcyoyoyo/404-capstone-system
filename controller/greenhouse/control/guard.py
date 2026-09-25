"""Actuator protection (§3.4): minimum on/off times, maximum run, daily caps, cooldowns.

A decision that violates a constraint is deferred (retried next cycle), not discarded.
Safety OFFs bypass the timers — a pump must stop on low water even if it only just started.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from ..registry import ActuatorDef


@dataclass
class ActState:
    on: bool = False
    since: datetime | None = None
    mode: str = "AUTO"               # AUTO | MANUAL
    manual_on: bool | None = None
    manual_until: datetime | None = None
    manual_cmd: str | None = None
    manual_by: str | None = None
    run_day: date | None = None
    run_today_s: float = 0.0
    cooldown_until: datetime | None = None
    reason: str | None = None
    lockout: str | None = None
    extra: dict = field(default_factory=dict)

    def running_for(self, now: datetime) -> float:
        if not self.on or self.since is None:
            return 0.0
        return (now - self.since).total_seconds()


def roll_day(st: ActState, now: datetime) -> None:
    today = now.date()
    if st.run_day != today:
        st.run_day, st.run_today_s = today, 0.0


def check(adef: ActuatorDef, st: ActState, target_on: bool, now: datetime, bypass: bool = False) -> tuple[bool, str | None, float]:
    """Returns (allowed, reason_if_not, seconds_until_allowed)."""
    if target_on == st.on:
        return True, None, 0
    if bypass and not target_on:
        return True, None, 0
    elapsed = (now - st.since).total_seconds() if st.since else 1e9
    if target_on:
        if st.cooldown_until and now < st.cooldown_until:
            return False, "COOLDOWN", (st.cooldown_until - now).total_seconds()
        if elapsed < adef.min_off_s:
            return False, "MIN_OFF_TIME", adef.min_off_s - elapsed
        if adef.daily_cap_s is not None:
            roll_day(st, now)
            if st.run_today_s >= adef.daily_cap_s:
                return False, "DAILY_CAP", 0
    else:
        if elapsed < adef.min_on_s:
            return False, "MIN_ON_TIME", adef.min_on_s - elapsed
    return True, None, 0


def set_state(st: ActState, on: bool, now: datetime, reason: str) -> None:
    if st.on and not on and st.since is not None:
        roll_day(st, now)
        st.run_today_s += (now - st.since).total_seconds()
    st.on, st.since, st.reason = on, now, reason


def start_cooldown(st: ActState, now: datetime, seconds: float) -> None:
    st.cooldown_until = now + timedelta(seconds=seconds)
