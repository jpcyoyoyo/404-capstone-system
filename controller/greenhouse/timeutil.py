from __future__ import annotations

from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo

_TZ = ZoneInfo("Asia/Manila")


def set_local_tz(name: str) -> None:
    global _TZ
    _TZ = ZoneInfo(name)


def local_tz() -> ZoneInfo:
    return _TZ


def utcnow() -> datetime:
    """Naive UTC — the form stored in the database."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def iso(dt: datetime | None) -> str | None:
    """ISO-8601 with the greenhouse's local offset, e.g. 2026-10-13T08:00:00+08:00."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(_TZ).isoformat(timespec="seconds")


def parse_iso(s: str | None) -> datetime | None:
    """Parse ISO-8601 to naive UTC. Naive input is taken as UTC."""
    if not s:
        return None
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def local_time_of(dt_utc: datetime) -> datetime:
    return dt_utc.replace(tzinfo=timezone.utc).astimezone(_TZ)


__all__ = ["utcnow", "iso", "parse_iso", "local_tz", "set_local_tz", "local_time_of", "timedelta"]
