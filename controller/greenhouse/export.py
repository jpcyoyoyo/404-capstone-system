"""Data export for Records (19 Nov 2026): any period, any record type, as CSV files ready for Excel.

One dataset comes back as a single .csv; several come back as a .zip with one .csv each and a
README.txt that says what every column means. All files:

* are UTF-8 with a byte-order mark, so Excel shows °C, µS/cm and Filipino names correctly;
* give every time twice: ``time_local`` in the greenhouse's time zone as ``YYYY-MM-DD HH:MM:SS``
  (Excel reads it as a date) and ``time_utc`` in ISO 8601;
* guard text cells against formula injection: text starting with = + - @ is prefixed with '.

Sensor readings can be every stored reading (``raw``) or averages per 15 minutes, hour or local day,
one row per reading (``long``) or one column per sensor (``wide``, for charts in Excel). Averages
combine the raw readings with the 15-minute averages kept after raw readings are removed
(services/sensors.py, retention), so long periods export as far back as the data goes.
"""
from __future__ import annotations

import csv
import io
import json
import zipfile
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from tempfile import SpooledTemporaryFile
from typing import Any

from sqlalchemy import desc, func, select

from .db import Database
from .models import (ActuatorEvent, Alert, AuditLog, FertigationDose, PowerEvent, SensorReading, SensorReading15m)
from .registry import Registry
from .timeutil import local_time_of, local_tz, utcnow

DATASETS = ("readings", "summary", "water", "fertilizer", "activity", "alerts", "power")
RESOLUTIONS = ("raw", "15m", "1h", "1d")
WIDTH_S = {"15m": 900, "1h": 3600}
MAX_DAYS = 400
BOM = "﻿"


@dataclass
class ExportRequest:
    datasets: list[str]
    t0: datetime                      # naive UTC
    t1: datetime
    sensors: list[str] = field(default_factory=list)   # empty: all that match `types`
    types: list[str] = field(default_factory=list)     # empty: all
    resolution: str = "raw"
    layout: str = "long"              # long | wide (wide needs averages)
    invalid: bool = False             # raw readings that failed checks, with their quality code
    source: str = "controller"        # where the file came from, for the README

    def check(self, reg: Registry) -> None:
        bad = [d for d in self.datasets if d not in DATASETS]
        if bad or not self.datasets:
            raise ValueError(f"datasets must be some of {', '.join(DATASETS)}")
        if self.resolution not in RESOLUTIONS:
            raise ValueError(f"resolution must be one of {', '.join(RESOLUTIONS)}")
        if self.layout not in ("long", "wide"):
            raise ValueError("layout must be long or wide")
        if self.layout == "wide" and self.resolution == "raw":
            raise ValueError("one column per sensor needs averages (15m, 1h or 1d): raw readings are not taken at the same moments")
        if self.t1 <= self.t0:
            raise ValueError("the period ends before it starts")
        if self.t1 - self.t0 > timedelta(days=MAX_DAYS):
            raise ValueError(f"the period can be at most {MAX_DAYS} days")
        unknown = [s for s in self.sensors if not reg.has_sensor(s)]
        if unknown:
            raise ValueError(f"no sensor {', '.join(unknown)}")

    def sensor_defs(self, reg: Registry):
        return [s for s in reg.sensors if (not self.sensors or s.id in self.sensors)
                and (not self.types or s.type in self.types)]


# ── cells ───────────────────────────────────────────────────────────────────
def local(dt: datetime | None) -> str:
    return local_time_of(dt).strftime("%Y-%m-%d %H:%M:%S") if dt else ""


def utc(dt: datetime | None) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ") if dt else ""


def cell(v: Any) -> Any:
    if v is None:
        return ""
    if isinstance(v, float):
        return round(v, 4)
    if isinstance(v, (dict, list)):
        v = json.dumps(v, ensure_ascii=False, separators=(",", ":"))
    if isinstance(v, str) and v[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + v
    return v


class Table:
    """One CSV file, written row by row (nothing is held in memory)."""

    def __init__(self, name: str, columns: list[str], rows: Iterable[list[Any]], about: str, notes: dict[str, str]):
        self.name, self.columns, self.rows, self.about, self.notes = name, columns, rows, about, notes
        self.count = 0

    def chunks(self) -> Iterator[str]:
        buf = io.StringIO()
        w = csv.writer(buf, lineterminator="\r\n")
        buf.write(BOM)
        w.writerow(self.columns)
        for r in self.rows:
            w.writerow([cell(v) for v in r])
            self.count += 1
            if buf.tell() > 64_000:
                yield buf.getvalue()
                buf.seek(0)
                buf.truncate()
        yield buf.getvalue()


# ── sensor readings ─────────────────────────────────────────────────────────
def _bucket(t: datetime, resolution: str) -> datetime:
    """Start of the bucket holding UTC time t: 15 minutes or an hour, or the local day."""
    if resolution == "1d":
        lt = local_time_of(t)
        start = lt.replace(hour=0, minute=0, second=0, microsecond=0)
        return start.astimezone(timezone.utc).replace(tzinfo=None)
    w = WIDTH_S[resolution]
    s = int((t - datetime(1970, 1, 1)).total_seconds()) // w * w
    return datetime(1970, 1, 1) + timedelta(seconds=s)


def averages(db: Database, ids: list[str], t0: datetime, t1: datetime, resolution: str) -> dict[tuple[str, datetime], list]:
    """{(sensor, bucket start): [sum, n, min, max]} from VALID raw readings and kept 15-minute averages."""
    acc: dict[tuple[str, datetime], list] = {}

    def add(sid, b, total, n, lo, hi):
        a = acc.get((sid, b))
        if a is None:
            acc[(sid, b)] = [total, n, lo, hi]
        else:
            a[0] += total; a[1] += n; a[2] = min(a[2], lo); a[3] = max(a[3], hi)

    with db.session() as s:
        q = (select(SensorReading.sensor_id, SensorReading.recorded_at, SensorReading.value)
             .where(SensorReading.sensor_id.in_(ids), SensorReading.recorded_at >= t0, SensorReading.recorded_at < t1,
                    SensorReading.quality == "VALID", SensorReading.value.is_not(None)))
        for sid, t, v in s.execute(q).yield_per(5000):
            add(sid, _bucket(t, resolution), v, 1, v, v)
        q = select(SensorReading15m).where(SensorReading15m.sensor_id.in_(ids), SensorReading15m.bucket_start >= t0,
                                           SensorReading15m.bucket_start < t1)
        for a in s.execute(q).scalars().yield_per(5000):
            n = max(1, a.samples)
            add(a.sensor_id, _bucket(a.bucket_start, resolution), a.avg_value * n, n, a.min_value, a.max_value)
    return acc


def readings_table(db: Database, reg: Registry, rq: ExportRequest) -> Table:
    defs = rq.sensor_defs(reg)
    ids = [d.id for d in defs]
    by_id = {d.id: d for d in defs}
    notes = {"time_local": f"time at the greenhouse ({local_tz().key})", "time_utc": "the same moment in UTC",
             "sensor_id": "sensor (contract/registry.yaml)", "type": "what it measures", "zone": "greenhouse zone (0: shared)",
             "unit": "unit of value"}
    if rq.resolution == "raw":
        def rows():
            with db.session() as s:
                q = (select(SensorReading.recorded_at, SensorReading.sensor_id, SensorReading.value, SensorReading.raw,
                            SensorReading.quality)
                     .where(SensorReading.sensor_id.in_(ids), SensorReading.recorded_at >= rq.t0,
                            SensorReading.recorded_at < rq.t1)
                     .order_by(SensorReading.recorded_at, SensorReading.sensor_id))
                if not rq.invalid:
                    q = q.where(SensorReading.quality == "VALID")
                for t, sid, v, raw, q_ in s.execute(q).yield_per(5000):
                    d = by_id[sid]
                    yield [local(t), utc(t), sid, d.type, d.zone, d.unit, v, raw, q_]
        notes.update({"value": "the reading, calibrated", "raw": "what the sensor sent before calibration (volts, counts)",
                      "quality": "VALID, or why the reading was not used (INVALID, OUT_OF_RANGE, UNCALIBRATED, WARMING …)"})
        return Table("sensor_readings", ["time_local", "time_utc", "sensor_id", "type", "zone", "unit", "value", "raw", "quality"],
                     rows(), "Every stored reading" + ("" if rq.invalid else " that passed its checks (VALID)") +
                     ". Raw readings are kept 7 days on the controller (pH and EC 30); for older periods choose averages.", notes)

    label = {"15m": "15-minute", "1h": "hourly", "1d": "daily (local midnight to midnight)"}[rq.resolution]
    acc = averages(db, ids, rq.t0, rq.t1, rq.resolution)
    if rq.layout == "wide":
        times = sorted({b for (_, b) in acc})
        cols = [f"{sid} ({by_id[sid].unit})" if by_id[sid].unit else sid for sid in ids]

        def rows():
            for b in times:
                yield [local(b), utc(b)] + [round(acc[(sid, b)][0] / acc[(sid, b)][1], 3) if (sid, b) in acc else ""
                                            for sid in ids]
        notes.update({"<sensor> (<unit>)": f"{label} average of that sensor's valid readings; empty: no reading"})
        return Table("sensor_averages_by_sensor", ["time_local", "time_utc"] + cols, rows(),
                     f"{label.capitalize()} averages, one column per sensor (ready for an Excel chart). "
                     "Times are the start of each period.", notes)

    def rows():
        for (sid, b), (total, n, lo, hi) in sorted(acc.items(), key=lambda kv: (kv[0][1], kv[0][0])):
            d = by_id[sid]
            yield [local(b), utc(b), sid, d.type, d.zone, d.unit, round(total / n, 3), lo, hi, n]
    notes.update({"average": f"{label} mean of the valid readings", "min": "lowest valid reading", "max": "highest valid reading",
                  "samples": "number of readings averaged"})
    return Table("sensor_averages", ["time_local", "time_utc", "sensor_id", "type", "zone", "unit", "average", "min", "max", "samples"],
                 rows(), f"{label.capitalize()} averages of the valid readings, one row per sensor and period. "
                 "Times are the start of each period.", notes)


def summary_table(db: Database, reg: Registry, rq: ExportRequest) -> Table:
    defs = rq.sensor_defs(reg)
    ids = [d.id for d in defs]
    stats: dict[str, dict[str, Any]] = {sid: {"n": 0, "valid": 0, "sum": 0.0, "lo": None, "hi": None, "first": None, "last": None}
                                        for sid in ids}
    with db.session() as s:
        q = (select(SensorReading.sensor_id, SensorReading.quality, func.count(), func.sum(SensorReading.value),
                    func.min(SensorReading.value), func.max(SensorReading.value),
                    func.min(SensorReading.recorded_at), func.max(SensorReading.recorded_at))
             .where(SensorReading.sensor_id.in_(ids), SensorReading.recorded_at >= rq.t0, SensorReading.recorded_at < rq.t1)
             .group_by(SensorReading.sensor_id, SensorReading.quality))
        for sid, q_, n, total, lo, hi, first, last in s.execute(q):
            st = stats[sid]
            st["n"] += n
            st["first"] = min(filter(None, [st["first"], first]), default=None)
            st["last"] = max(filter(None, [st["last"], last]), default=None)
            if q_ == "VALID" and total is not None:
                st["valid"] += n; st["sum"] += total
                st["lo"] = lo if st["lo"] is None else min(st["lo"], lo)
                st["hi"] = hi if st["hi"] is None else max(st["hi"], hi)
        q = (select(SensorReading15m.sensor_id, func.sum(SensorReading15m.samples),
                    func.sum(SensorReading15m.avg_value * SensorReading15m.samples), func.min(SensorReading15m.min_value),
                    func.max(SensorReading15m.max_value), func.min(SensorReading15m.bucket_start), func.max(SensorReading15m.bucket_start))
             .where(SensorReading15m.sensor_id.in_(ids), SensorReading15m.bucket_start >= rq.t0, SensorReading15m.bucket_start < rq.t1)
             .group_by(SensorReading15m.sensor_id))
        for sid, n, total, lo, hi, first, last in s.execute(q):
            st = stats[sid]
            n = int(n or 0)
            st["n"] += n; st["valid"] += n; st["sum"] += float(total or 0)
            st["lo"] = lo if st["lo"] is None else min(st["lo"], lo)
            st["hi"] = hi if st["hi"] is None else max(st["hi"], hi)
            st["first"] = min(filter(None, [st["first"], first]), default=None)
            st["last"] = max(filter(None, [st["last"], last]), default=None)

    def rows():
        for d in defs:
            st = stats[d.id]
            yield [d.id, d.type, d.zone, d.unit, st["n"], st["valid"],
                   round(100 * st["valid"] / st["n"], 1) if st["n"] else "",
                   st["lo"], round(st["sum"] / st["valid"], 3) if st["valid"] else "", st["hi"],
                   local(st["first"]), local(st["last"])]
    return Table("sensor_summary",
                 ["sensor_id", "type", "zone", "unit", "readings", "valid", "valid_percent", "min", "mean", "max",
                  "first_local", "last_local"], rows(),
                 "One row per sensor for the whole period: how many readings it sent, how many passed their checks, "
                 "and the lowest, mean and highest valid value.",
                 {"readings": "readings stored (older periods: readings behind the 15-minute averages)",
                  "valid_percent": "share of readings that passed their checks", "mean": "mean of the valid readings"})


# ── water, fertilizer, activity, alerts, power ──────────────────────────────
def water_days(db: Database, reg: Registry, t0: datetime, t1: datetime) -> list[dict[str, Any]]:
    """Litres per local day, from the flow sensor when installed, else estimated from pump run time."""
    per_day: dict[str, dict] = {}
    flow = list(reg.sensors_of("water_flow"))
    with db.session() as s:
        if flow:
            rows = s.execute(select(SensorReading.recorded_at, SensorReading.value).where(
                SensorReading.sensor_id == flow[0].id, SensorReading.recorded_at >= t0, SensorReading.recorded_at < t1,
                SensorReading.quality == "VALID").order_by(SensorReading.recorded_at)).all()
            prev = None
            for t, v in rows:
                if prev is not None and v is not None:
                    dt = min((t - prev).total_seconds(), 120)
                    d = local_time_of(t).date().isoformat()
                    per_day.setdefault(d, {"litres": 0.0, "pump_minutes": 0.0, "method": "flow_sensor"})
                    per_day[d]["litres"] += v * dt / 60.0
                prev = t
        ev = s.execute(select(ActuatorEvent.occurred_at, ActuatorEvent.action).where(
            ActuatorEvent.actuator_id == "pump", ActuatorEvent.action.in_(["ON", "OFF"]),
            ActuatorEvent.occurred_at >= t0, ActuatorEvent.occurred_at < t1).order_by(ActuatorEvent.occurred_at)).all()
    started = None
    assumed_lpm = float(reg.control.get("assumed_flow_lpm", 6.0))
    for t, a in ev:
        if a == "ON":
            started = t
        elif started is not None:
            d = local_time_of(started).date().isoformat()
            row = per_day.setdefault(d, {"litres": 0.0, "pump_minutes": 0.0, "method": "estimated_from_run_time"})
            mins = (t - started).total_seconds() / 60.0
            row["pump_minutes"] += mins
            if row["method"] != "flow_sensor":
                row["litres"] += mins * assumed_lpm
            started = None
    return [{"date": d, **{k: (round(v, 2) if isinstance(v, float) else v) for k, v in r.items()}}
            for d, r in sorted(per_day.items())]


def water_table(db: Database, reg: Registry, rq: ExportRequest) -> Table:
    days = water_days(db, reg, rq.t0, rq.t1)
    lpm = float(reg.control.get("assumed_flow_lpm", 6.0))
    return Table("water_use", ["date", "litres", "pump_minutes", "method"],
                 ([d["date"], d["litres"], d["pump_minutes"], d["method"]] for d in days),
                 "Water used per local day.",
                 {"method": f"flow_sensor: measured; estimated_from_run_time: pump minutes × {lpm} L/min"})


def fertilizer_table(db: Database, reg: Registry, rq: ExportRequest) -> Table:
    def rows():
        with db.session() as s:
            for d in s.execute(select(FertigationDose).where(FertigationDose.started_at >= rq.t0,
                                                              FertigationDose.started_at < rq.t1)
                               .order_by(FertigationDose.started_at)).scalars():
                err = round(d.delivered_g - d.target_g, 2) if d.delivered_g is not None else None
                yield [local(d.started_at), utc(d.started_at), local(d.finished_at), d.target_g, d.delivered_g, err,
                       d.status, d.reason, d.source, d.issued_by]
    return Table("fertilizer_doses", ["started_local", "started_utc", "finished_local", "target_g", "delivered_g", "error_g",
                                      "status", "reason", "source", "issued_by"], rows(),
                 "Every fertilizer dose: how much was asked for and delivered, by weight on the load cell.",
                 {"error_g": "delivered minus target", "reason": "why a dose stopped early (empty when complete)",
                  "source": "auto (the controller) or manual (a person)"})


def activity_table(db: Database, reg: Registry, rq: ExportRequest) -> Table:
    names = {a.id: a.name for a in reg.actuators}

    def rows():
        with db.session() as s:
            ev = s.execute(select(ActuatorEvent).where(ActuatorEvent.occurred_at >= rq.t0, ActuatorEvent.occurred_at < rq.t1)
                           .order_by(ActuatorEvent.occurred_at)).scalars().all()
            au = s.execute(select(AuditLog).where(AuditLog.occurred_at >= rq.t0, AuditLog.occurred_at < rq.t1)
                           .order_by(AuditLog.occurred_at)).scalars().all()
            items = [(e.occurred_at, ["device", e.issued_by, names.get(e.actuator_id, e.actuator_id), e.action, e.reason,
                                      e.source, e.duration_s, e.detail]) for e in ev]
            items += [(a.occurred_at, ["person", a.actor, a.target, a.action, "", "", None, a.detail]) for a in au]
        for t, r in sorted(items, key=lambda x: x[0]):
            yield [local(t), utc(t)] + r
    return Table("activity", ["time_local", "time_utc", "kind", "by", "device_or_target", "action", "reason", "source",
                              "duration_s", "detail"], rows(),
                 "Everything the devices did (pump, fans, lights, doser …) and everything people did in the app.",
                 {"kind": "device: an output switched or held; person: a sign-in, setting change or command",
                  "source": "auto, manual, safety or boot (devices)", "detail": "extra facts, as JSON"})


def alerts_table(db: Database, reg: Registry, rq: ExportRequest) -> Table:
    from .push import alert_title

    def rows():
        with db.session() as s:
            for a in s.execute(select(Alert).where(Alert.raised_at >= rq.t0, Alert.raised_at < rq.t1)
                               .order_by(Alert.raised_at)).scalars():
                open_s = ((a.resolved_at or utcnow()) - a.raised_at).total_seconds()
                yield [local(a.raised_at), utc(a.raised_at), a.severity, a.code, alert_title(a.code), a.message, a.source,
                       local(a.resolved_at), round(open_s / 60, 1), local(a.acknowledged_at), a.acknowledged_by or ""]
    return Table("alerts", ["raised_local", "raised_utc", "severity", "code", "title", "message", "source", "resolved_local",
                            "open_minutes", "acknowledged_local", "acknowledged_by"], rows(),
                 "Every alert raised in the period.",
                 {"open_minutes": "from raised to resolved (to now if still open)", "source": "sensor or device it is about"})


def power_table(db: Database, reg: Registry, rq: ExportRequest) -> Table:
    def rows():
        with db.session() as s:
            when = func.coalesce(PowerEvent.ended_at, PowerEvent.started_at, PowerEvent.recorded_at)
            for e in s.execute(select(PowerEvent).where(when >= rq.t0, when < rq.t1).order_by(when)).scalars():
                yield [e.kind, local(e.started_at), local(e.ended_at), e.duration_s,
                       round(e.duration_s / 60, 1) if e.duration_s is not None else None, e.message]
    return Table("power_events", ["kind", "started_local", "ended_local", "duration_s", "duration_min", "message"], rows(),
                 "Power cuts, restarts and low-voltage warnings seen by the controller.",
                 {"kind": "outage, restart, undervoltage or unexplained", "started_local": "last moment the power was surely on"})


BUILDERS = {"readings": readings_table, "summary": summary_table, "water": water_table, "fertilizer": fertilizer_table,
            "activity": activity_table, "alerts": alerts_table, "power": power_table}


# ── files ───────────────────────────────────────────────────────────────────
def file_stem(rq: ExportRequest) -> str:
    a, b = local_time_of(rq.t0).date(), local_time_of(rq.t1 - timedelta(seconds=1)).date()
    what = rq.datasets[0] if len(rq.datasets) == 1 else "records"
    if what == "readings":
        what = "sensors-" + ("raw" if rq.resolution == "raw" else rq.resolution)
    return f"greenhouse-{what}_{a.isoformat()}" + ("" if a == b else f"_to_{b.isoformat()}")


def readme(rq: ExportRequest, tables: list[Table]) -> str:
    out = [f"Greenhouse records — {local(rq.t0)} to {local(rq.t1)} ({local_tz().key})",
           f"Exported {local(utcnow())} from the {rq.source}.", "",
           "Each .csv file opens in Excel or Google Sheets (UTF-8). Times are given twice: time_local at the",
           "greenhouse and time_utc. Text that starts with = + - or @ has a ' in front so a spreadsheet does not",
           "run it as a formula.", ""]
    for t in tables:
        out += [f"{t.name}.csv — {t.count} rows", f"  {t.about}"]
        out += [f"  {k}: {v}" for k, v in t.notes.items()]
        out.append("")
    return "\r\n".join(out)


def build(db: Database, reg: Registry, rq: ExportRequest) -> tuple[str, str, Iterator[bytes]]:
    """(file name, media type, content) for the request; rq.check() first."""
    tables = [BUILDERS[d](db, reg, rq) for d in rq.datasets]
    stem = file_stem(rq)
    if len(tables) == 1:
        t = tables[0]
        return f"{stem}.csv", "text/csv; charset=utf-8", (c.encode("utf-8") for c in t.chunks())

    spool = SpooledTemporaryFile(max_size=32 * 1024 * 1024)
    with zipfile.ZipFile(spool, "w", zipfile.ZIP_DEFLATED) as z:
        for t in tables:
            with z.open(f"{t.name}.csv", "w") as f:
                for c in t.chunks():
                    f.write(c.encode("utf-8"))
        z.writestr("README.txt", (BOM + readme(rq, tables)).encode("utf-8"))
    spool.seek(0)

    def stream():
        try:
            while chunk := spool.read(256 * 1024):
                yield chunk
        finally:
            spool.close()
    return f"{stem}.zip", "application/zip", stream()


__all__ = ["DATASETS", "RESOLUTIONS", "ExportRequest", "build", "water_days"]
