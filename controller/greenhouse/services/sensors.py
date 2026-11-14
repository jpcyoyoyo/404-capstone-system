"""greenhouse-sensors: node readings in, Pi-attached sensors polled, quality flagged, stored, published.

Integration Plan §3.1: "Polls local sensors, subscribes to node publications, applies
quality flags, writes to the database and publishes to the broker."

Clock (9 Nov 2026): while the system clock is not yet trusted (see greenhouse.clock) readings are
still flagged and published live, but held in memory with a monotonic timestamp instead of being
stored. When the clock is trusted they are stored with recorded_at worked back from the trusted
clock, so a reboot without internet no longer leaves readings at wrong times in the database.
Retention does not run while the clock is untrusted.
"""
from __future__ import annotations

import logging
import threading
import time
from collections import deque
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import delete, func, select

from .. import quality
from ..clock import AlwaysTrusted
from ..bus import Bus, Topics
from ..db import Database
from ..hal import Hal, RawSample
from ..models import Sensor, SensorReading, SensorReading15m
from ..registry import Registry, SensorDef
from ..timeutil import iso, parse_iso, utcnow
from .common import CalibrationStore

log = logging.getLogger(__name__)

RAW_RETENTION_DAYS = {"ph": 30, "ec": 30}
DEFAULT_RAW_RETENTION_DAYS = 7
MAX_HELD_READINGS = 50_000   # about a day of every installed sensor; the oldest go first beyond this


class SensorService:
    def __init__(self, reg: Registry, db: Database, bus: Bus, hal: Hal, clock=None,
                 mono=time.monotonic, max_held: int = MAX_HELD_READINGS):
        self.reg, self.db, self.bus, self.hal = reg, db, bus, hal
        self.topics = Topics(reg.greenhouse_id)
        self.cal = CalibrationStore(db)
        self.clock = clock or AlwaysTrusted()
        self._mono = mono
        self._started_mono = mono()
        self.started_at = utcnow()
        # (monotonic time, row) for readings taken before the clock was trusted
        self._held: deque[tuple[float, SensorReading]] = deque(maxlen=max_held)
        self._dropped = 0
        self._last_hold_log = -1e9
        self.warmup_s = float(reg.control.get("co2_warmup_s", 180))
        self._last_poll: dict[str, float] = {}
        self._latest: dict[str, dict[str, Any]] = {}
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self._push_stock_constants()

    def _push_stock_constants(self) -> None:
        for sd in self.reg.sensors:
            if sd.type == "stock_weight":
                setattr(self.hal, "stock_constants", self.cal.get(sd.id))

    # ── lifecycle ────────────────────────────────────────────────────────
    def start(self) -> None:
        self.bus.subscribe(self.topics.node_raw(), self._on_node_raw)
        self.bus.subscribe(f"{self.topics.base}/config/changed", self._on_config)
        for target, name in ((self._poll_loop, "poll"), (self._retention_loop, "retention")):
            t = threading.Thread(target=target, name=f"sensors-{name}", daemon=True)
            t.start()
            self._threads.append(t)
        log.info("sensor service started")

    def stop(self) -> None:
        self._stop.set()

    def _on_config(self, topic: str, payload: dict) -> None:
        if payload.get("what") == "calibration":
            self.cal.refresh()
            self._push_stock_constants()

    # ── ingest ───────────────────────────────────────────────────────────
    def _on_node_raw(self, topic: str, payload: dict) -> None:
        node = Topics.segment(topic, 3)
        ts = parse_iso(payload.get("ts")) or utcnow()
        # Nodes without a synced clock send ts=null; a clock more than 5 min off is not trusted either.
        # While the Pi's own clock is untrusted, arrival time is used (ingest holds the readings).
        if abs((utcnow() - ts).total_seconds()) > 300 or not self.clock.trusted():
            ts = utcnow()
        samples = []
        for r in payload.get("readings", []):
            sid = r.get("sensor_id")
            if not sid or not self.reg.has_sensor(sid) or self.reg.sensor(sid).host != node:
                log.debug("ignoring %s from %s", sid, node)
                continue
            samples.append(RawSample(sid, r.get("raw"), bool(r.get("ok", False)), r.get("error")))
        self.ingest(samples, ts)

    def ingest(self, samples: list[RawSample], ts: datetime | None = None) -> list[dict[str, Any]]:
        trusted = self.clock.trusted()
        if trusted and self._held:
            self.flush_held()
        ts = ts or utcnow()
        wtemp = self._water_temp()
        # Warm-up is measured on the monotonic clock, so a clock correction cannot end it early.
        started = ts - timedelta(seconds=self._mono() - self._started_mono)
        out, rows = [], []
        for smp in samples:
            sd = self.reg.sensor(smp.sensor_id)
            if not sd.installed:
                continue
            value, q = quality.evaluate(sd, smp.raw, smp.ok, self.cal.get(sd.id), ts, started,
                                        warmup_s=self.warmup_s,
                                        water_temp_c=wtemp if sd.type in ("ph", "ec") else None)
            payload = {"sensor_id": sd.id, "zone_id": sd.zone, "type": sd.type, "value": value,
                       "unit": sd.unit, "raw": smp.raw, "quality": q, "ts": iso(ts)}
            rows.append(SensorReading(sensor_id=sd.id, value=value, raw=smp.raw, unit=sd.unit, quality=q, recorded_at=ts))
            self._latest[sd.id] = payload
            out.append(payload)
        if rows and not trusted:
            self._hold(rows)
        elif rows:
            with self.db.session() as s:
                s.add_all(rows)
                for p in out:
                    sensor = s.get(Sensor, p["sensor_id"])
                    if sensor is not None:
                        sensor.status = p["quality"].lower()
        for p in out:
            self.bus.publish(self.topics.reading(p["zone_id"], p["sensor_id"]), p, retain=True)
        return out

    # ── readings taken before the clock was trusted ──────────────────────
    def _hold(self, rows: list[SensorReading]) -> None:
        m = self._mono()
        for r in rows:
            if len(self._held) == self._held.maxlen:
                self._dropped += 1
            self._held.append((m, r))
        if m - self._last_hold_log >= 300:
            self._last_hold_log = m
            log.warning("system clock not trusted yet (%s): holding %d readings, not stored%s",
                        getattr(self.clock, "reason", "?"), len(self._held),
                        f"; {self._dropped} oldest dropped" if self._dropped else "")

    def held_count(self) -> int:
        return len(self._held)

    def flush_held(self) -> int:
        """Store held readings with recorded_at = trusted now minus their age on the monotonic clock."""
        if not self._held:
            return 0
        now, m = utcnow(), self._mono()
        held = list(self._held)
        self._held.clear()
        last_q: dict[str, str] = {}
        with self.db.session() as s:
            for when, row in held:
                row.recorded_at = now - timedelta(seconds=m - when)
                s.add(row)
                last_q[row.sensor_id] = row.quality
            for sid, q in last_q.items():
                sensor = s.get(Sensor, sid)
                if sensor is not None:
                    sensor.status = q.lower()
        log.info("system clock trusted (%s): stored %d held readings with corrected times%s",
                 getattr(self.clock, "reason", "?"), len(held),
                 f" ({self._dropped} oldest had been dropped)" if self._dropped else "")
        self._dropped = 0
        return len(held)

    def _water_temp(self) -> float | None:
        for sd in self.reg.sensors_of("water_temperature"):
            p = self._latest.get(sd.id)
            if p and p["quality"] == "VALID":
                return p["value"]
        return None

    # ── polling Pi-attached sensors ──────────────────────────────────────
    def local_sensors(self) -> list[SensorDef]:
        return [s for s in self.reg.sensors if s.host == "pi" and s.installed]

    def poll_once(self, force: bool = False) -> list[dict[str, Any]]:
        now_m = time.monotonic()
        due = [s for s in self.local_sensors()
               if force or now_m - self._last_poll.get(s.id, -1e9) >= s.interval_s]
        if not due:
            return []
        for s in due:
            self._last_poll[s.id] = now_m
        # water temperature first so pH/EC compensation uses this cycle's value
        due.sort(key=lambda s: 0 if s.type == "water_temperature" else 1)
        return self.ingest(self.hal.read_local(due))

    def _poll_loop(self) -> None:
        while not self._stop.is_set():
            try:
                if self._held and self.clock.trusted():
                    self.flush_held()
                self.poll_once()
            except Exception:
                log.exception("local sensor poll failed")
            self._stop.wait(1.0)

    # ── retention (§8.1): raw 7 days (pH/EC 30), then 15-minute aggregates ─
    def run_retention(self, now: datetime | None = None) -> int:
        if now is None and not self.clock.trusted():
            return 0   # a wrong clock could delete or roll up the wrong rows
        now = now or utcnow()
        removed = 0
        with self.db.session() as s:
            for sd in self.reg.sensors:
                keep = RAW_RETENTION_DAYS.get(sd.type, DEFAULT_RAW_RETENTION_DAYS)
                cutoff = now - timedelta(days=keep)
                old = s.execute(select(SensorReading.recorded_at, SensorReading.value)
                                .where(SensorReading.sensor_id == sd.id, SensorReading.recorded_at < cutoff,
                                       SensorReading.quality == "VALID")).all()
                buckets: dict[datetime, list[float]] = {}
                for t, v in old:
                    b = t.replace(minute=t.minute - t.minute % 15, second=0, microsecond=0)
                    buckets.setdefault(b, []).append(v)
                for b, vals in buckets.items():
                    exists = s.execute(select(func.count()).select_from(SensorReading15m).where(
                        SensorReading15m.sensor_id == sd.id, SensorReading15m.bucket_start == b)).scalar()
                    if not exists:
                        s.add(SensorReading15m(sensor_id=sd.id, bucket_start=b, avg_value=sum(vals) / len(vals),
                                               min_value=min(vals), max_value=max(vals), samples=len(vals)))
                res = s.execute(delete(SensorReading).where(SensorReading.sensor_id == sd.id,
                                                            SensorReading.recorded_at < cutoff))
                removed += res.rowcount or 0
        return removed

    def _retention_loop(self) -> None:
        while not self._stop.wait(3600):
            try:
                n = self.run_retention()
                if n:
                    log.info("retention: rolled up and removed %d raw readings", n)
            except Exception:
                log.exception("retention failed")
