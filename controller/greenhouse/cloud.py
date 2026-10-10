"""Connection to the cloud server (the read-mostly replica on the VPS). Required in production.

Where the settings come from, in order:

1. the database (``cloud:url`` and ``cloud:token``), written by ``ghctl cloud setup``, the app
   (More → Settings → Cloud) or the greenhouse display;
2. the environment (``GH_CLOUD_URL`` and ``GH_SYNC_TOKEN`` in /etc/greenhouse/greenhouse.env).

The sync service re-reads them before every pass, so a change takes effect within a minute without
a restart. Keys starting with ``cloud:`` are never replicated (see services/sync.py): the token
stays on the Pi.

The sync service records how each pass went in ``cloud:status`` (JSON). The control service turns
that into alerts: CLOUD_NOT_CONFIGURED while no server is set, CLOUD_UNREACHABLE when nothing has
been uploaded for :data:`STALE_AFTER`.
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from .config import Settings
from .db import Database
from .timeutil import iso, parse_iso, utcnow

URL_KEY = "cloud:url"
TOKEN_KEY = "cloud:token"
STATUS_KEY = "cloud:status"
PREFIX = "cloud:"
STALE_AFTER = timedelta(minutes=30)
_URL_RE = re.compile(r"^https?://[A-Za-z0-9.\-]+(:\d{1,5})?(/[^\s]*)?$")


@dataclass
class CloudConfig:
    url: str | None
    token: str | None
    source: str | None   # "app" (database) | "env" | None

    @property
    def configured(self) -> bool:
        return bool(self.url and self.token)


def normalise_url(url: str) -> str:
    u = (url or "").strip().rstrip("/")
    if u and "://" not in u:
        u = "https://" + u
    if not _URL_RE.match(u):
        raise ValueError("enter the server address, e.g. https://greenhouse.example.com")
    return u


def get_config(db: Database, settings: Settings) -> CloudConfig:
    url, token = db.kv_get(URL_KEY), db.kv_get(TOKEN_KEY)
    if url and token:
        return CloudConfig(url, token, "app")
    if settings.cloud_url and settings.sync_token:
        return CloudConfig(settings.cloud_url.rstrip("/"), settings.sync_token, "env")
    return CloudConfig(None, None, None)


def save_config(db: Database, url: str, token: str) -> CloudConfig:
    u = normalise_url(url)
    t = (token or "").strip()
    if len(t) < 16:
        raise ValueError("the sync token is at least 16 characters (copy GH_SYNC_TOKEN from the server's cloud.env)")
    db.kv_set(URL_KEY, u)
    db.kv_set(TOKEN_KEY, t)
    db.kv_set(STATUS_KEY, "{}")      # the old server's history no longer applies
    return CloudConfig(u, t, "app")


def clear_config(db: Database) -> None:
    db.kv_set(URL_KEY, "")
    db.kv_set(TOKEN_KEY, "")
    db.kv_set(STATUS_KEY, "{}")


def record(db: Database, *, ok: bool, rows: int = 0, error: str | None = None, configured: bool = True,
           now: datetime | None = None) -> None:
    now = now or utcnow()
    st = read_status(db)
    st.update({"configured": configured, "last_attempt_at": iso(now)})
    if ok:
        st.update({"last_ok_at": iso(now), "last_rows": rows, "last_error": None})
        st["total_rows"] = int(st.get("total_rows") or 0) + rows
    else:
        st["last_error"] = (error or "")[:200] or None
    db.kv_set(STATUS_KEY, json.dumps(st))


def read_status(db: Database) -> dict[str, Any]:
    try:
        return json.loads(db.kv_get(STATUS_KEY) or "{}")
    except ValueError:
        return {}


def state(db: Database, settings: Settings, now: datetime | None = None) -> dict[str, Any]:
    """What the app and the display show. Never includes the token."""
    now = now or utcnow()
    cfg = get_config(db, settings)
    st = read_status(db)
    last_ok = parse_iso(st.get("last_ok_at"))
    last_try = parse_iso(st.get("last_attempt_at"))
    if not cfg.configured:
        health = "not_configured"
    elif last_try is None:
        health = "waiting"            # just set up; the first pass has not run yet
    elif st.get("last_error") or last_ok is None or now - last_ok >= STALE_AFTER:
        health = "error"
    else:
        health = "ok"
    return {"required": True, "configured": cfg.configured, "source": cfg.source, "url": cfg.url,
            "token_set": bool(cfg.token), "health": health, "last_ok_at": st.get("last_ok_at"),
            "last_attempt_at": st.get("last_attempt_at"), "last_error": st.get("last_error"),
            "last_rows": st.get("last_rows"), "total_rows": st.get("total_rows")}


def alert_condition(db: Database, settings: Settings, now: datetime | None = None,
                    since: datetime | None = None) -> tuple[str, str] | None:
    """(code, message) for the control service's alert list, or None when all is well.

    ``since`` is when the control service started: a fresh boot gets the grace period too."""
    now = now or utcnow()
    s = state(db, settings, now)
    if not s["configured"]:
        return ("CLOUD_NOT_CONFIGURED", "The cloud server is not set up — records are kept only on the controller. "
                                        "Set it up in More → Settings → Cloud or on the greenhouse display.")
    last_ok = parse_iso(s["last_ok_at"])
    ref = last_ok or since or now
    if now - ref >= STALE_AFTER:
        ago = int((now - ref).total_seconds() // 60)
        why = f" ({s['last_error']})" if s.get("last_error") else ""
        return ("CLOUD_UNREACHABLE", f"Nothing uploaded to the cloud server for {ago} min{why}. Data is kept on the "
                                     "controller and uploads resume when the connection returns.")
    return None


def test_connection(url: str, token: str, timeout: float = 8.0, opener=None) -> dict[str, Any]:
    """Checks the address answers as a greenhouse cloud server and accepts the token. Never raises."""
    open_ = opener or urllib.request.urlopen
    steps: list[dict[str, Any]] = []
    try:
        base = normalise_url(url)
    except ValueError as e:
        return {"ok": False, "steps": [{"step": "address", "ok": False, "detail": str(e)}]}
    try:
        with open_(urllib.request.Request(f"{base}/health"), timeout=timeout) as r:
            body = json.loads(r.read().decode() or "{}")
        if body.get("role") != "cloud":
            steps.append({"step": "server", "ok": False,
                          "detail": f"that address is a greenhouse {body.get('role') or 'server'}, not the cloud server"})
            return {"ok": False, "steps": steps}
        steps.append({"step": "server", "ok": True, "detail": f"cloud server v{body.get('version', '?')} answered"})
    except Exception as e:  # DNS, TLS, timeout, not JSON …
        steps.append({"step": "server", "ok": False, "detail": f"cannot reach {base} ({_short(e)})"})
        return {"ok": False, "steps": steps}
    req = urllib.request.Request(f"{base}/sync/ingest", method="POST",
                                 data=json.dumps({"table": "kv", "rows": []}).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {token.strip()}"})
    try:
        with open_(req, timeout=timeout) as r:
            ok = r.status < 300
        steps.append({"step": "token", "ok": ok, "detail": "sync token accepted" if ok else f"server returned {r.status}"})
    except urllib.error.HTTPError as e:
        steps.append({"step": "token", "ok": False,
                      "detail": "the server refused the sync token" if e.code == 401 else f"server returned {e.code}"})
    except Exception as e:
        steps.append({"step": "token", "ok": False, "detail": _short(e)})
    return {"ok": all(s["ok"] for s in steps), "steps": steps}


def _short(e: Exception) -> str:
    r = getattr(e, "reason", None)
    return str(r or e)[:120]
