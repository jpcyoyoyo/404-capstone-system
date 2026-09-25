"""greenhouse-sync: replicates the controller's database to the cloud replica.

Append-only tables are sent in id order behind a per-table watermark, so an outage
simply resumes where it stopped — no gaps and no duplicates (the cloud upserts by id).
Small tables are sent whole. The cloud is never authoritative (§1.1).
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
from ..models import SYNCED_APPEND_TABLES, SYNCED_SNAPSHOT_TABLES, Alert
from ..timeutil import parse_iso, utcnow

log = logging.getLogger(__name__)
BATCH = 2000


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


MODELS = {m.__tablename__: m for m in SYNCED_APPEND_TABLES + SYNCED_SNAPSHOT_TABLES}


def ingest(db: Database, table: str, rows: list[dict[str, Any]]) -> int:
    model = MODELS.get(table)
    if model is None:
        raise ValueError(f"table {table} is not replicated")
    with db.session() as s:
        for d in rows:
            s.merge(dict_to_row(model, d))
    return len(rows)


class SyncService:
    def __init__(self, db: Database, cloud_url: str, token: str, interval_s: float = 60.0, post=None):
        self.db, self.cloud_url, self.token, self.interval_s = db, cloud_url.rstrip("/"), token, interval_s
        self._post = post or self._http_post
        self._stop = threading.Event()
        self.online = False

    def _http_post(self, table: str, rows: list[dict]) -> None:
        body = json.dumps({"table": table, "rows": rows}).encode()
        req = urllib.request.Request(f"{self.cloud_url}/sync/ingest", data=body, method="POST",
                                     headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.token}"})
        with urllib.request.urlopen(req, timeout=30) as r:
            if r.status >= 300:
                raise RuntimeError(f"cloud returned {r.status}")

    def sync_once(self) -> int:
        sent = 0
        for model in SYNCED_APPEND_TABLES:
            key = f"sync:{model.__tablename__}"
            while True:
                wm = int(self.db.kv_get(key, "0") or 0)
                with self.db.session() as s:
                    rows = s.execute(select(model).where(model.id > wm).order_by(model.id).limit(BATCH)).scalars().all()
                    batch = [row_to_dict(r) for r in rows]
                if not batch:
                    break
                self._post(model.__tablename__, batch)
                self.db.kv_set(key, str(batch[-1]["id"]))
                sent += len(batch)
                if len(batch) < BATCH:
                    break
        for model in SYNCED_SNAPSHOT_TABLES:
            with self.db.session() as s:
                q = select(model)
                if model is Alert:
                    q = q.where((Alert.resolved_at.is_(None)) | (Alert.raised_at > utcnow() - timedelta(days=7)))
                batch = [row_to_dict(r) for r in s.execute(q).scalars().all()]
            if batch:
                self._post(model.__tablename__, batch)
                sent += len(batch)
        return sent

    def start(self) -> None:
        threading.Thread(target=self._loop, name="sync", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                n = self.sync_once()
                if not self.online:
                    log.info("cloud reachable again")
                self.online = True
                log.debug("synced %d rows", n)
            except Exception as e:
                if self.online:
                    log.warning("cloud unreachable (%s); will retry — local operation is unaffected", e)
                self.online = False
            self._stop.wait(self.interval_s)
