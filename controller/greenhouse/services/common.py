"""Shared pieces for the services: calibration cache, alert bookkeeping, serialisers."""
from __future__ import annotations

import logging
import threading
from datetime import datetime
from typing import Any

from sqlalchemy import select

from ..bus import Bus, Topics
from ..control.types import AlertSignal
from ..db import Database
from ..models import Alert, Calibration
from ..timeutil import iso, utcnow

log = logging.getLogger(__name__)


class CalibrationStore:
    """Latest calibration constants per sensor; refreshed periodically and on request."""

    def __init__(self, db: Database):
        self.db = db
        self._lock = threading.Lock()
        self._consts: dict[str, dict] = {}
        self._at: dict[str, datetime] = {}
        self.refresh()

    def refresh(self) -> None:
        with self.db.session() as s:
            rows = s.execute(select(Calibration).order_by(Calibration.performed_at)).scalars().all()
            consts = {r.sensor_id: dict(r.constants) for r in rows}
            at = {r.sensor_id: r.performed_at for r in rows}
        with self._lock:
            self._consts, self._at = consts, at

    def get(self, sensor_id: str) -> dict | None:
        with self._lock:
            return self._consts.get(sensor_id)


def alert_payload(a: Alert) -> dict[str, Any]:
    return {"id": a.id, "severity": a.severity, "source": a.source, "code": a.code, "message": a.message,
            "raised_at": iso(a.raised_at), "resolved_at": iso(a.resolved_at),
            "acknowledged_by": a.acknowledged_by, "acknowledged_at": iso(a.acknowledged_at)}


class AlertManager:
    """Turns AlertSignals into alert rows.

    Condition alerts stay open while the condition persists (one row, last_seen updated)
    and resolve themselves when it clears. Event alerts are one-shot.
    `owner` scopes auto-resolution so the sensors and control services don't resolve each other's alerts.
    """

    def __init__(self, db: Database, bus: Bus, topics: Topics, owner: str):
        self.db, self.bus, self.topics, self.owner = db, bus, topics, owner

    def sync(self, signals: list[AlertSignal], now: datetime | None = None) -> list[Alert]:
        now = now or utcnow()
        raised: list[Alert] = []
        cond_keys = {f"{self.owner}|{s.key}" for s in signals if s.kind == "condition"}
        with self.db.session() as s:
            open_rows = s.execute(select(Alert).where(Alert.resolved_at.is_(None),
                                                      Alert.dedupe_key.like(f"{self.owner}|%"))).scalars().all()
            by_key = {a.dedupe_key: a for a in open_rows}
            for sig in signals:
                key = f"{self.owner}|{sig.key}"
                if key in by_key:
                    by_key[key].last_seen_at = now
                    continue
                a = Alert(severity=sig.severity, source=sig.source, code=sig.code, message=sig.message,
                          dedupe_key=key, raised_at=now, last_seen_at=now, detail={"kind": sig.kind})
                s.add(a)
                raised.append(a)
                by_key[key] = a
            for key, a in by_key.items():
                if (a.detail or {}).get("kind", "condition") == "condition" and key not in cond_keys and a.id is not None:
                    a.resolved_at = now
            s.flush()
        for a in raised:
            self.bus.publish(self.topics.alert, alert_payload(a), qos=1)
            log.info("ALERT %s %s: %s", a.severity, a.code, a.message)
        return raised
