"""greenhouse-sync: replicates the controller's database to the cloud replica.

Small tables (zones, sensors, thresholds, alerts, accounts, …) are sent whole first, so a new
cloud server has its settings and sign-ins within the first minute. Append-only tables follow in
id order behind a per-table watermark, so an outage — or the backlog on a first connection —
simply resumes where it stopped: no gaps and no duplicates (the cloud upserts by primary key,
one statement per chunk of rows). The cloud is never authoritative (§1.1).

The cloud server is required in production: when it is not set up, or cannot be reached, each pass
records why (greenhouse/cloud.py) and the control service raises an alert. Nothing is lost while the
connection is down: the watermarks only move after the server has accepted a batch.
"""
from __future__ import annotations

import json
import logging
import threading
import urllib.request
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import inspect as sa_inspect, select

from ..db import Database
from ..models import SYNCED_APPEND_TABLES, SYNCED_SNAPSHOT_TABLES, Alert, KeyValue
from ..timeutil import parse_iso, utcnow

log = logging.getLogger(__name__)
BATCH = 2000          # rows per request
UPSERT_CHUNK = 500    # rows per INSERT statement on the cloud side
TIMEOUT_S = 120       # a first upload into a cold cloud database can take a while
CLOUD_PREFIX = "cloud:"   # greenhouse/cloud.py PREFIX


def _attrs(model):
    return [(a.key, a.columns[0]) for a in sa_inspect(model).column_attrs]


def row_to_dict(row) -> dict[str, Any]:
    out = {}
    for key, _ in _attrs(type(row)):
        v = getattr(row, key)
        out[key] = v.isoformat() if isinstance(v, datetime) else v
    return out


def dict_to_row(model, d: dict[str, Any]):
    kwargs = {}
    for key, col in _attrs(model):
        if key not in d:
            continue
        v = d[key]
        if v is not None and col.type.python_type is datetime:
            v = parse_iso(v)
        kwargs[key] = v
    return model(**kwargs)


def _values(model, d: dict[str, Any]) -> dict[str, Any]:
    """A sent row as column name → value, for a bulk INSERT."""
    out: dict[str, Any] = {}
    for key, col in _attrs(model):
        if key not in d:
            continue
        v = d[key]
        if v is not None and col.type.python_type is datetime:
            v = parse_iso(v)
        out[col.name] = v
    return out


MODELS = {m.__tablename__: m for m in SYNCED_APPEND_TABLES + SYNCED_SNAPSHOT_TABLES}


def ingest(db: Database, table: str, rows: list[dict[str, Any]]) -> int:
    """Upsert rows by primary key: one INSERT … ON DUPLICATE KEY UPDATE (MySQL) or ON CONFLICT
    (SQLite) per chunk, instead of a lookup and a write per row, which was too slow for the
    backlog of a first connection (it timed out on Railway, 14 Nov 2026)."""
    model = MODELS.get(table)
    if model is None:
        raise ValueError(f"table {table} is not replicated")
    if not rows:
        return 0
    t = model.__table__
    pk = [c.name for c in t.primary_key.columns]
    vals = [_values(model, d) for d in rows]
    cols = sorted(set().union(*(v.keys() for v in vals)))
    vals = [{c: v.get(c) for c in cols} for v in vals]    # same columns in every row
    with db.session() as s:
        dialect = s.get_bind().dialect.name
        if dialect not in ("mysql", "sqlite"):
            for d in rows:
                s.merge(dict_to_row(model, d))
            return len(rows)
        for i in range(0, len(vals), UPSERT_CHUNK):
            chunk = vals[i:i + UPSERT_CHUNK]
            if dialect == "mysql":
                from sqlalchemy.dialects.mysql import insert as mysql_insert
                stmt = mysql_insert(t).values(chunk)
                upd = {c: stmt.inserted[c] for c in cols if c not in pk}
                stmt = stmt.on_duplicate_key_update(upd or {pk[0]: stmt.inserted[pk[0]]})
            else:
                from sqlalchemy.dialects.sqlite import insert as sqlite_insert
                stmt = sqlite_insert(t).values(chunk)
                upd = {c: stmt.excluded[c] for c in cols if c not in pk}
                stmt = (stmt.on_conflict_do_update(index_elements=pk, set_=upd) if upd
                        else stmt.on_conflict_do_nothing(index_elements=pk))
            s.execute(stmt)
    return len(rows)


class SyncService:
    """Pushes the controller's data to the cloud server.

    With ``settings`` the server address and token are looked up before every pass (database first,
    then the environment, see greenhouse/cloud.py), so a server set up from the app is used within a
    minute. ``cloud_url``/``token`` fix them instead (tests, one-off runs)."""

    def __init__(self, db: Database, cloud_url: str | None = None, token: str | None = None, interval_s: float = 60.0,
                 post=None, settings=None):
        self.db, self.interval_s, self.settings = db, interval_s, settings
        self.cloud_url = cloud_url.rstrip("/") if cloud_url else None
        self.token = token
        self._fixed_post = post
        self._stop = threading.Event()
        self.online = False
        self._warned_unconfigured = False

    def _resolve(self) -> bool:
        if self.settings is not None:
            from ..cloud import get_config
            cfg = get_config(self.db, self.settings)
            self.cloud_url, self.token = (cfg.url.rstrip("/") if cfg.url else None), cfg.token
        return bool(self.cloud_url and self.token)

    def _post(self, table: str, rows: list[dict]) -> None:
        if self._fixed_post is not None:
            return self._fixed_post(table, rows)
        return self._http_post(table, rows)

    def _http_post(self, table: str, rows: list[dict]) -> None:
        body = json.dumps({"table": table, "rows": rows}).encode()
        req = urllib.request.Request(f"{self.cloud_url}/sync/ingest", data=body, method="POST",
                                     headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.token}"})
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
            if r.status >= 300:
                raise RuntimeError(f"cloud returned {r.status}")

    def sync_once(self, progress=None) -> int:
        """Send everything new. ``progress(rows)`` is called after each accepted request, so the
        status shows a long first upload moving instead of "waiting" until it has all gone."""
        sent = 0

        def accepted(n: int) -> None:
            nonlocal sent
            sent += n
            if progress is not None:
                progress(n)

        for model in SYNCED_SNAPSHOT_TABLES:
            with self.db.session() as s:
                q = select(model)
                if model is Alert:
                    q = q.where((Alert.resolved_at.is_(None)) | (Alert.raised_at > utcnow() - timedelta(days=7)))
                if model is KeyValue:   # the cloud token and connection status stay on the Pi
                    q = q.where(~KeyValue.key.startswith(CLOUD_PREFIX))
                batch = [row_to_dict(r) for r in s.execute(q).scalars().all()]
            if batch:
                self._post(model.__tablename__, batch)
                accepted(len(batch))
        for model in SYNCED_APPEND_TABLES:
            key = f"sync:{model.__tablename__}"
            while not self._stop.is_set():
                wm = int(self.db.kv_get(key, "0") or 0)
                with self.db.session() as s:
                    rows = s.execute(select(model).where(model.id > wm).order_by(model.id).limit(BATCH)).scalars().all()
                    batch = [row_to_dict(r) for r in rows]
                if not batch:
                    break
                self._post(model.__tablename__, batch)
                self.db.kv_set(key, str(batch[-1]["id"]))
                accepted(len(batch))
                if len(batch) < BATCH:
                    break
        return sent

    def run_pass(self) -> int | None:
        """One pass with bookkeeping for the app and the alerts. Returns rows sent, or None if not configured."""
        from .. import cloud
        if not self._resolve():
            if not self._warned_unconfigured:
                log.warning("cloud server not set up — run `sudo ghctl cloud setup`, or use More → Settings → Cloud")
                self._warned_unconfigured = True
            cloud.record(self.db, ok=False, configured=False, error="not set up")
            self.online = False
            return None
        self._warned_unconfigured = False
        def progress(rows: int) -> None:
            if not self.online:
                log.info("cloud reachable (%s)", self.cloud_url)
            self.online = True
            cloud.record(self.db, ok=True, rows=rows)

        try:
            n = self.sync_once(progress)
        except Exception as e:
            if self.online:
                log.warning("cloud unreachable (%s); will retry — local operation is unaffected", e)
            self.online = False
            cloud.record(self.db, ok=False, error=_reason(e))
            return 0
        if not n:   # nothing new: still a successful pass
            if not self.online:
                log.info("cloud reachable (%s)", self.cloud_url)
            self.online = True
            cloud.record(self.db, ok=True, rows=0)
        log.debug("synced %d rows", n)
        return n

    def start(self) -> None:
        threading.Thread(target=self._loop, name="sync", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.run_pass()
            except Exception:
                log.exception("sync pass failed")
            self._stop.wait(self.interval_s)


def _reason(e: Exception) -> str:
    import urllib.error
    if isinstance(e, urllib.error.HTTPError):
        return "the server refused the sync token" if e.code == 401 else f"server returned {e.code}"
    r = getattr(e, "reason", None)
    return str(r or e)[:200]
