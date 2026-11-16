"""Web Push notifications from the cloud server (added 17 Nov 2026).

The phone gets a notification even when the app is closed, the screen is off or another app is
open. It works in the web app opened from the cloud server's https address (installed from Chrome
or Edge, or on an iPhone added to the Home Screen); the Android APK and the Pi's own http address
cannot receive Web Push, so the app offers the switch only where it works.

How it fits together:

* Keys: one VAPID key pair signs every notification. ``greenhouse push keys`` makes a new pair;
  only the private key is configured (``GH_VAPID_PRIVATE_KEY``), the public key is worked out from
  it and given to the browsers. Keep the same key on every cloud server (Railway, later Hostinger):
  a browser's subscription only accepts notifications signed with the key it subscribed with.
* Subscriptions: the app subscribes the browser (service worker ``app/public/sw.js``) and sends the
  subscription here (POST /push/subscription). They are stored in ``push_subscriptions`` on the
  cloud only, with the account and a level: "all" alerts or "urgent" ones (high and critical).
  A subscription belongs to the web address it was made on: after moving to a new address each
  phone turns notifications on again there.
* What is sent:
  - each new alert that reaches the cloud with the minute's upload (raised in the last 15 min, still
    open and unacknowledged), with the same title as the app; more than three at once become one
    summary, so a backlog after an outage is one notification, not dozens;
  - "Greenhouse controller not reporting" when its heartbeat has not arrived for 5 min (power or
    internet at the greenhouse), and "back" when it returns. Only the cloud can send these: when
    the greenhouse is cut off it cannot tell anyone itself.
* Delivery runs on a background thread so an upload is never held up by a push service. A
  subscription the push service reports as gone (404/410: the app was uninstalled, or notifications
  were blocked) is deleted. Accounts that are deactivated get nothing.
* Endpoints are only accepted on the browsers' own push services (Google, Mozilla, Apple,
  Microsoft), so the server never posts to an address a user typed in.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import queue
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Callable
from urllib.parse import urlparse

from sqlalchemy import select

from .db import Database
from .models import Alert, PushSubscription, User
from .timeutil import iso, local_time_of, parse_iso, utcnow

log = logging.getLogger(__name__)

RANK = {"info": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}
LEVELS = {"all": 0, "urgent": 3}                 # lowest severity each level receives
FRESH = timedelta(minutes=15)                    # older alerts in an upload are not pushed
MAX_SINGLE = 3                                   # more new alerts at once → one summary
OFFLINE_AFTER = timedelta(minutes=5)             # heartbeat older than this: controller not reporting
BACK_WITHIN = timedelta(minutes=3)               # heartbeat newer than this: reporting again
FORGET_AFTER = timedelta(hours=24)               # a heartbeat older than this when we first look: say nothing
WATCH_EVERY_S = 60
TTL_S = 24 * 3600                                # a phone that is off gets it within a day
STATE_KEY = "push:controller"                    # not "cloud:" (that prefix is the Pi's) and never synced back
PUSH_HOSTS = ("fcm.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com")
SEVERITY_WORD = {"critical": "Critical", "high": "Urgent", "medium": "Warning", "low": "Notice", "info": "Info"}

# Same titles as the app (app/src/contract/codes.ts, ALERT_TITLE); tests/test_push.py keeps them in step.
ALERT_TITLE: dict[str, str] = {
    "LOW_WATER": "Reservoir low",
    "FLOAT_SWITCH_FAULT": "Float switch fault",
    "NODE_OFFLINE": "Sensing node offline",
    "SENSOR_INVALID": "Sensor giving bad readings",
    "SENSOR_STALE": "Sensor not reporting",
    "SENSOR_UNCALIBRATED": "Sensor needs calibration",
    "ZONE_MANUAL_REQUIRED": "Zone needs manual control",
    "MAX_RUN_EXCEEDED": "Run-time limit hit",
    "THRESHOLD_BREACH": "Out of range",
    "ESTOP": "Emergency stop",
    "CONTROLLER_OFFLINE": "Controller offline",
    "DOSE_ABORTED": "Fertilizer dose stopped",
    "LOAD_CELL_FAULT": "Dose stopped — load cell not reading",
    "NO_FLOW": "Dose stopped — no solution moved",
    "TIMEOUT": "Dose stopped — time limit",
    "INTERLOCK": "Dose stopped — safety lock",
    "NO_DOSER": "Dose stopped — pump not available",
    "PUMP_ERROR": "Dose stopped — pump driver error",
    "STOCK_LOW": "Stock bottle low",
    "HAL_ERROR": "Hardware error",
    "ACTUATOR_FAULT": "Device did not switch",
    "STAGE_CHANGED": "Growth stage changed",
    "HARVEST_DUE": "Harvest due",
    "CLOUD_NOT_CONFIGURED": "Cloud server not set up",
    "CLOUD_UNREACHABLE": "Cloud server not reachable",
    "POWER_OUTAGE": "Power cut",
    "UNDERVOLTAGE": "Supply voltage dipped",
}


def alert_title(code: str) -> str:
    if code in ALERT_TITLE:
        return ALERT_TITLE[code]
    if code.startswith("DOSE"):
        return "Fertilizer dose problem"
    t = code.replace("_", " ").lower()
    return t[:1].upper() + t[1:]


# ── keys ────────────────────────────────────────────────────────────────────
def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    s = s.strip()
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def generate_keys() -> tuple[str, str]:
    """(private, public), both base64url: the private key is the raw 32-byte P-256 secret, the public
    key the 65-byte uncompressed point that browsers take as applicationServerKey."""
    from cryptography.hazmat.primitives.asymmetric import ec
    k = ec.generate_private_key(ec.SECP256R1())
    return _b64(k.private_numbers().private_value.to_bytes(32, "big")), _public_of(k)


def _public_of(k) -> str:
    from cryptography.hazmat.primitives import serialization
    return _b64(k.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))


def public_key_of(private_b64: str) -> str:
    from cryptography.hazmat.primitives.asymmetric import ec
    raw = _unb64(private_b64)
    if len(raw) != 32:
        raise ValueError("GH_VAPID_PRIVATE_KEY is not a key from `greenhouse push keys` (expected 32 bytes)")
    return _public_of(ec.derive_private_key(int.from_bytes(raw, "big"), ec.SECP256R1()))


def endpoint_allowed(endpoint: str) -> bool:
    u = urlparse(endpoint or "")
    host = (u.hostname or "").lower()
    return u.scheme == "https" and any(host == h or host.endswith("." + h) for h in PUSH_HOSTS)


def level_admits(level: str, severity: str) -> bool:
    return RANK.get(severity, 2) >= LEVELS.get(level, 0)


# ── sending ─────────────────────────────────────────────────────────────────
@dataclass
class Message:
    title: str
    body: str
    severity: str = "medium"
    tag: str = "greenhouse"
    url: str = "/tabs/alerts"
    user_id: int | None = None          # only this account's devices (the test button)
    renotify: bool = True
    data: dict = field(default_factory=dict)

    def payload(self) -> str:
        return json.dumps({"title": self.title, "body": self.body, "severity": self.severity, "tag": self.tag,
                           "url": self.url, "renotify": self.renotify, "ts": iso(utcnow()), **self.data})


def _webpush_send(sub: dict, data: str, vapid, subject: str, urgency: str) -> int:
    """POST one encrypted message to the browser's push service; returns the HTTP status."""
    from pywebpush import WebPushException, webpush
    try:
        # A fresh claims dict each time: pywebpush fills in "aud" from the endpoint it is given.
        r = webpush(sub, data=data, vapid_private_key=vapid, vapid_claims={"sub": subject}, ttl=TTL_S,
                    headers={"Urgency": urgency}, timeout=10)
        return r.status_code
    except WebPushException as e:
        if e.response is not None:
            return e.response.status_code
        raise


SendFn = Callable[[dict, str, Any, str, str], int]


class PushService:
    def __init__(self, db: Database, settings, reg=None, send: SendFn | None = None,
                 now: Callable[[], datetime] = utcnow):
        self.db, self.settings, self.reg = db, settings, reg
        self._send = send or _webpush_send
        self._now = now
        self._q: queue.Queue[Message] = queue.Queue()
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self.public_key: str | None = None
        self._vapid = None
        self.reason = ""
        self._load()

    # ── configuration ────────────────────────────────────────────────────
    def _load(self) -> None:
        s = self.settings
        if getattr(s, "role", "controller") != "cloud":
            self.reason = "Notifications are sent by the cloud server. Open the app from the cloud address to turn them on."
            return
        if not s.vapid_private_key:
            self.reason = "The cloud server has no notification key yet (GH_VAPID_PRIVATE_KEY; see deploy/cloud/RAILWAY.md)."
            return
        if not s.vapid_subject:
            self.reason = "The cloud server needs a contact for the push services (GH_VAPID_SUBJECT, e.g. mailto: or https: address)."
            return
        try:
            self.public_key = public_key_of(s.vapid_private_key)
            if self._send is _webpush_send:
                from py_vapid import Vapid
                self._vapid = Vapid.from_raw(s.vapid_private_key.strip().encode())
        except Exception as e:
            self.public_key, self._vapid = None, None
            self.reason = f"The notification key on the cloud server is not valid ({e})."
            log.error("push: %s", self.reason)
            return
        self.reason = ""

    @property
    def available(self) -> bool:
        return self.public_key is not None

    # ── subscriptions ────────────────────────────────────────────────────
    @staticmethod
    def _hash(endpoint: str) -> str:
        return hashlib.sha256(endpoint.encode()).hexdigest()

    def subscribe(self, user_id: int, sub: dict, level: str = "all", label: str = "") -> dict:
        endpoint = str(sub.get("endpoint") or "")
        keys = sub.get("keys") or {}
        p256dh, auth = str(keys.get("p256dh") or ""), str(keys.get("auth") or "")
        if not endpoint_allowed(endpoint) or len(endpoint) > 2000:
            raise ValueError("that is not a browser push address")
        try:
            if len(_unb64(p256dh)) != 65 or len(_unb64(auth)) != 16:
                raise ValueError
        except Exception:
            raise ValueError("the browser's push keys are missing or malformed") from None
        if level not in LEVELS:
            raise ValueError("level is 'all' or 'urgent'")
        h = self._hash(endpoint)
        with self.db.session() as s:
            row = s.execute(select(PushSubscription).where(PushSubscription.endpoint_hash == h)).scalar_one_or_none()
            if row is None:
                row = PushSubscription(endpoint_hash=h, endpoint=endpoint, created_at=self._now())
                s.add(row)
            # A browser that signs in with another account moves to that account.
            row.p256dh, row.auth, row.user_id, row.level = p256dh, auth, user_id, level
            row.label, row.failures, row.last_error = (label or "")[:120], 0, None
        return {"registered": True, "level": level}

    def check(self, user_id: int, endpoint: str) -> dict:
        with self.db.session() as s:
            row = s.execute(select(PushSubscription).where(PushSubscription.endpoint_hash == self._hash(endpoint or ""))).scalar_one_or_none()
            if row is None or row.user_id != user_id:
                return {"registered": False, "level": None}
            return {"registered": True, "level": row.level}

    def unsubscribe(self, endpoint: str) -> bool:
        with self.db.session() as s:
            row = s.execute(select(PushSubscription).where(PushSubscription.endpoint_hash == self._hash(endpoint or ""))).scalar_one_or_none()
            if row is None:
                return False
            s.delete(row)
            return True

    def device_count(self, user_id: int) -> int:
        with self.db.session() as s:
            return len(s.execute(select(PushSubscription.id).where(PushSubscription.user_id == user_id)).all())

    # ── delivery ─────────────────────────────────────────────────────────
    def notify(self, msg: Message) -> None:
        """Queue a message for the background thread (or send it now if the thread is not running)."""
        if not self.available:
            return
        if self._threads:
            self._q.put(msg)
        else:
            self.deliver(msg)

    def deliver(self, msg: Message) -> dict[str, int]:
        out = {"sent": 0, "removed": 0, "failed": 0}
        if not self.available:
            return out
        with self.db.session() as s:
            q = (select(PushSubscription).join(User, User.id == PushSubscription.user_id)
                 .where(User.active.is_(True)))
            if msg.user_id is not None:
                q = q.where(PushSubscription.user_id == msg.user_id)
            subs = [r for r in s.execute(q).scalars().all() if msg.user_id is not None or level_admits(r.level, msg.severity)]
            targets = [(r.id, {"endpoint": r.endpoint, "keys": {"p256dh": r.p256dh, "auth": r.auth}}) for r in subs]
        data = msg.payload()
        urgency = "high" if RANK.get(msg.severity, 2) >= 3 else "normal"
        results: list[tuple[int, int | None, str | None]] = []
        for sid, info in targets:
            try:
                status = self._send(info, data, self._vapid, self.settings.vapid_subject, urgency)
                results.append((sid, status, None))
            except Exception as e:      # network trouble: keep the subscription, note the error
                results.append((sid, None, str(e)[:200]))
        now = self._now()
        with self.db.session() as s:
            for sid, status, err in results:
                row = s.get(PushSubscription, sid)
                if row is None:
                    continue
                if status is not None and status < 300:
                    row.last_sent_at, row.failures, row.last_error = now, 0, None
                    out["sent"] += 1
                elif status in (404, 410):          # gone: uninstalled, blocked or expired
                    s.delete(row)
                    out["removed"] += 1
                else:
                    row.failures = (row.failures or 0) + 1
                    row.last_error = err or f"push service returned {status}"
                    out["failed"] += 1
        if targets:
            log.info("push %r: %s", msg.title, out)
        return out

    # ── what is sent ─────────────────────────────────────────────────────
    def fresh_alerts(self, rows: list[dict]) -> list[dict]:
        """Of an uploaded batch of alerts (before it is stored), the ones worth a notification."""
        if not self.available or not rows:
            return []
        now = self._now()
        ids = [r.get("id") for r in rows if r.get("id") is not None]
        with self.db.session() as s:
            known = {i for (i,) in s.execute(select(Alert.id).where(Alert.id.in_(ids))).all()} if ids else set()
        out = []
        for r in rows:
            raised = parse_iso(r.get("raised_at"))
            if (r.get("id") in known or r.get("resolved_at") or r.get("acknowledged_at") or raised is None
                    or now - raised > FRESH):
                continue
            out.append(r)
        return out

    def alerts(self, rows: list[dict]) -> None:
        if not rows:
            return
        rows = sorted(rows, key=lambda r: (-RANK.get(r.get("severity"), 2), str(r.get("raised_at"))))
        if len(rows) <= MAX_SINGLE:
            for r in rows:
                sev = r.get("severity") or "medium"
                self.notify(Message(title=alert_title(str(r.get("code") or "")), body=str(r.get("message") or ""),
                                    severity=sev, tag=f"alert-{r.get('id')}", url=f"/tabs/alert-detail/{r.get('id')}",
                                    data={"alert_id": r.get("id"), "code": r.get("code")}))
            return
        titles = []
        for r in rows:
            t = alert_title(str(r.get("code") or ""))
            if t not in titles:
                titles.append(t)
        body = ", ".join(titles[:4]) + (f" and {len(titles) - 4} more" if len(titles) > 4 else "") + ". Open the app for details."
        self.notify(Message(title=f"{len(rows)} new greenhouse alerts", body=body,
                            severity=rows[0].get("severity") or "medium", tag="alerts-batch", url="/tabs/alerts"))

    def check_controller(self) -> Message | None:
        """Notify when the controller's heartbeat stops reaching the cloud, and when it returns."""
        from .cloud import CONTROLLER_STATUS_KEY
        if not self.available:
            return None
        now = self._now()
        try:
            st = json.loads(self.db.kv_get(CONTROLLER_STATUS_KEY) or "{}")
            prev = json.loads(self.db.kv_get(STATE_KEY) or "{}")
        except ValueError:
            return None
        ts = parse_iso(st.get("ts"))
        if ts is None:
            return None
        age = now - ts
        was = prev.get("state")
        msg = None
        if age >= OFFLINE_AFTER and was != "offline":
            self.db.kv_set(STATE_KEY, json.dumps({"state": "offline", "last_heartbeat": iso(ts)}))
            if was is None and age > FORGET_AFTER:
                return None             # first look at a controller long silent: nothing new to report
            mins = int(age.total_seconds() // 60)
            msg = Message(
                title="Greenhouse controller not reporting",
                body=(f"Nothing from the greenhouse controller since {self._hm(ts)} ({mins} min). The greenhouse may "
                      "have lost power or internet. If only the internet is down, the controller keeps running and "
                      "uploads what it missed when the connection returns."),
                severity="high", tag="controller-status", url="/tabs/dashboard")
        elif age < BACK_WITHIN and was == "offline":
            last = parse_iso(prev.get("last_heartbeat"))
            self.db.kv_set(STATE_KEY, json.dumps({"state": "online", "last_heartbeat": iso(ts)}))
            gap = f"; silent for about {self._dur(ts - last)}" if last else ""
            msg = Message(title="Greenhouse controller reporting again",
                          body=f"The greenhouse controller is reporting again (last heard {self._hm(ts)}{gap}).",
                          severity="high", tag="controller-status", url="/tabs/dashboard")
        elif was is None and age < BACK_WITHIN:
            self.db.kv_set(STATE_KEY, json.dumps({"state": "online", "last_heartbeat": iso(ts)}))
        if msg:
            self.notify(msg)
        return msg

    @staticmethod
    def _hm(dt: datetime) -> str:
        return local_time_of(dt).strftime("%H:%M")

    @staticmethod
    def _dur(d: timedelta) -> str:
        m = max(1, int(round(d.total_seconds() / 60)))
        return f"{m} min" if m < 60 else f"{m // 60} h {m % 60} min"

    # ── threads ──────────────────────────────────────────────────────────
    def start(self) -> None:
        if not self.available or self._threads:
            return
        for name, target in (("push-send", self._send_loop), ("push-watch", self._watch_loop)):
            t = threading.Thread(target=target, name=name, daemon=True)
            t.start()
            self._threads.append(t)
        log.info("push notifications on (public key %s…)", (self.public_key or "")[:12])

    def stop(self) -> None:
        self._stop.set()

    def _send_loop(self) -> None:
        while not self._stop.is_set():
            try:
                msg = self._q.get(timeout=1)
            except queue.Empty:
                continue
            try:
                self.deliver(msg)
            except Exception:
                log.exception("push delivery failed")

    def _watch_loop(self) -> None:
        while not self._stop.wait(WATCH_EVERY_S):
            try:
                self.check_controller()
            except Exception:
                log.exception("push: controller check failed")
