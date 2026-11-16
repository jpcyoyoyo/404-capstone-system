"""Web Push from the cloud server (greenhouse/push.py, 17 Nov 2026)."""
from __future__ import annotations

import base64
import json
import re
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from greenhouse import cloud as cloudmod
from greenhouse import push as pushmod
from greenhouse.models import PushSubscription, User
from greenhouse.services.api import create_app
from greenhouse.timeutil import iso, utcnow

from .test_api import Rig

CODES_TS = Path(__file__).resolve().parents[2] / "app" / "src" / "contract" / "codes.ts"


def b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def browser_sub(n: int = 1, host: str = "fcm.googleapis.com") -> dict:
    """A subscription shaped like the one a browser makes (real P-256 public key, 16-byte secret)."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    k = ec.generate_private_key(ec.SECP256R1())
    pub = k.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return {"endpoint": f"https://{host}/fcm/send/device-{n}", "keys": {"p256dh": b64(pub), "auth": b64(bytes(range(16)))}}


class FakePushService:
    """Stands in for Google's/Mozilla's push service: records what was sent, answers a set status."""

    def __init__(self):
        self.sent: list[tuple[str, dict]] = []
        self.status: dict[str, int] = {}

    def __call__(self, sub, data, vapid, subject, urgency):
        self.sent.append((sub["endpoint"], {**json.loads(data), "_urgency": urgency, "_subject": subject}))
        return self.status.get(sub["endpoint"], 201)

    def titles(self):
        return [d["title"] for _, d in self.sent]


@pytest.fixture
def cloud(tmp_path):
    cl = Rig(tmp_path, role="cloud")
    private, _ = pushmod.generate_keys()
    cl.settings.vapid_private_key, cl.settings.vapid_subject = private, "mailto:test@example.com"
    cl.fake = FakePushService()
    cl.push = pushmod.PushService(cl.db, cl.settings, cl.reg, send=cl.fake)
    cl.app = create_app(cl.settings, cl.reg, cl.db, cl.bus, push=cl.push)
    cl.client = TestClient(cl.app)
    return cl


def subscribe(cl, email="admin@test.ph", n=1, level="all"):
    h = cl.login(email)
    sub = browser_sub(n)
    r = cl.client.post("/push/subscription", json={"subscription": sub, "level": level, "label": "Chrome on Android"}, headers=h)
    assert r.status_code == 200, r.text
    return h, sub


def upload_alerts(cl, rows):
    r = cl.client.post("/sync/ingest", json={"table": "alerts", "rows": rows}, headers={"Authorization": "Bearer sync-tok"})
    assert r.status_code == 200, r.text


def alert_row(i, code="LOW_WATER", severity="high", ago=timedelta(minutes=1), **kw):
    t = utcnow() - ago
    return {"id": i, "severity": severity, "source": "control", "code": code, "message": f"message {i}",
            "dedupe_key": f"control|{code}|{i}", "raised_at": t.isoformat(), "last_seen_at": t.isoformat(),
            "resolved_at": None, "acknowledged_by": None, "acknowledged_at": None, "detail": {"kind": "condition"}, **kw}


# ── keys ────────────────────────────────────────────────────────────────────
def test_keys_round_trip_and_sign_like_py_vapid():
    private, public = pushmod.generate_keys()
    assert pushmod.public_key_of(private) == public
    assert len(base64.urlsafe_b64decode(public + "=" * (-len(public) % 4))) == 65
    from py_vapid import Vapid
    headers = Vapid.from_raw(private.encode()).sign({"sub": "mailto:test@example.com", "aud": "https://fcm.googleapis.com"})
    assert f"k={public}" in headers["Authorization"]          # browsers check this against applicationServerKey
    with pytest.raises(ValueError):
        pushmod.public_key_of(b64(b"short"))


def test_message_encrypts_for_the_browser_key():
    """What pywebpush sends can be decrypted with the browser's key (checks the subscription format)."""
    import http_ece
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from pywebpush import WebPusher
    k = ec.generate_private_key(ec.SECP256R1())
    pub = k.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    auth = bytes(range(16))
    sub = {"endpoint": "https://fcm.googleapis.com/fcm/send/x", "keys": {"p256dh": b64(pub), "auth": b64(auth)}}
    body = WebPusher(sub).encode(b'{"title": "Reservoir low"}', content_encoding="aes128gcm")["body"]
    assert http_ece.decrypt(body, private_key=k, auth_secret=auth, version="aes128gcm") == b'{"title": "Reservoir low"}'


def test_titles_match_the_app():
    text = CODES_TS.read_text(encoding="utf-8")
    block = text[text.index("export const ALERT_TITLE"):]
    block = block[:block.index("};")]
    app = dict(re.findall(r"^\s+([A-Z0-9_]+): '([^']*)',", block, flags=re.M))
    assert app == pushmod.ALERT_TITLE
    assert pushmod.alert_title("DOSE_SOMETHING_NEW") == "Fertilizer dose problem"
    assert pushmod.alert_title("NEW_CODE") == "New code"


# ── where it is offered ───────────────────────────────────────────────────────
def test_controller_role_does_not_offer_push(tmp_path):
    pi = Rig(tmp_path)
    h = pi.login()
    c = pi.client.get("/push/config", headers=h).json()
    assert c["available"] is False and "cloud" in c["reason"]
    assert pi.client.get("/greenhouse", headers=h).json()["capabilities"]["push"] is False
    assert pi.client.post("/push/subscription", json={"subscription": browser_sub()}, headers=h).status_code == 409


def test_cloud_without_a_key_explains_why(tmp_path):
    cl = Rig(tmp_path, role="cloud")
    c = cl.client.get("/push/config", headers=cl.login()).json()
    assert c["available"] is False and "GH_VAPID_PRIVATE_KEY" in c["reason"]


def test_cloud_offers_push_with_its_public_key(cloud):
    h = cloud.login("viewer@test.ph")
    c = cloud.client.get("/push/config", headers=h).json()
    assert c["available"] and c["public_key"] == pushmod.public_key_of(cloud.settings.vapid_private_key)
    assert cloud.client.get("/greenhouse", headers=h).json()["capabilities"]["push"] is True


# ── subscriptions ───────────────────────────────────────────────────────────
def test_subscribe_check_and_unsubscribe(cloud):
    h, sub = subscribe(cloud, "viewer@test.ph", level="urgent")
    assert cloud.client.post("/push/subscription/check", json={"endpoint": sub["endpoint"]}, headers=h).json() == \
        {"registered": True, "level": "urgent"}
    assert cloud.client.get("/push/config", headers=h).json()["devices"] == 1
    # the same browser again only updates it
    r = cloud.client.post("/push/subscription", json={"subscription": sub, "level": "all"}, headers=h)
    assert r.json() == {"registered": True, "level": "all"}
    with cloud.db.session() as s:
        assert s.query(PushSubscription).count() == 1
    assert cloud.client.post("/push/unsubscribe", json={"endpoint": sub["endpoint"]}, headers=h).json()["removed"] is True
    assert cloud.client.post("/push/subscription/check", json={"endpoint": sub["endpoint"]}, headers=h).json()["registered"] is False


def test_only_browser_push_services_are_accepted(cloud):
    h = cloud.login()
    for bad in ("http://fcm.googleapis.com/x", "https://example.com/push", "https://fcm.googleapis.com.evil.net/x"):
        sub = browser_sub()
        sub["endpoint"] = bad
        r = cloud.client.post("/push/subscription", json={"subscription": sub}, headers=h)
        assert r.status_code == 422, bad
    sub = browser_sub()
    sub["keys"]["p256dh"] = "abc"
    assert cloud.client.post("/push/subscription", json={"subscription": sub}, headers=h).status_code == 422
    for host in ("updates.push.services.mozilla.com", "web.push.apple.com", "wns2-sg2p.notify.windows.com"):
        assert pushmod.endpoint_allowed(f"https://{host}/x")


def test_needs_a_signed_in_person(cloud):
    assert cloud.client.post("/push/subscription", json={"subscription": browser_sub()}).status_code == 401
    k = cloud.client.get("/auth/kiosk")
    if k.status_code == 200:
        hk = {"Authorization": f"Bearer {k.json()['access_token']}"}
        assert cloud.client.post("/push/subscription", json={"subscription": browser_sub()}, headers=hk).status_code == 403


def test_test_button_reaches_only_my_devices(cloud):
    h, mine = subscribe(cloud, "admin@test.ph", n=1)
    subscribe(cloud, "viewer@test.ph", n=2)
    r = cloud.client.post("/push/test", headers=h).json()
    assert r == {"sent": 1, "removed": 0, "failed": 0}
    assert [e for e, _ in cloud.fake.sent] == [mine["endpoint"]] and cloud.fake.titles() == ["Test notification"]


# ── alerts from the upload ──────────────────────────────────────────────────
def test_new_alert_is_pushed_once(cloud):
    _, sub = subscribe(cloud)
    upload_alerts(cloud, [alert_row(7)])
    assert cloud.fake.titles() == ["Reservoir low"]
    _, d = cloud.fake.sent[0]
    assert d["body"] == "message 7" and d["url"] == "/tabs/alert-detail/7" and d["tag"] == "alert-7"
    assert d["_urgency"] == "high" and d["_subject"] == "mailto:test@example.com"
    upload_alerts(cloud, [alert_row(7)])                       # the next minute's upload carries it again
    assert len(cloud.fake.sent) == 1


def test_old_resolved_or_acknowledged_alerts_are_not_pushed(cloud):
    subscribe(cloud)
    upload_alerts(cloud, [alert_row(1, ago=timedelta(hours=2)),               # a backlog after an outage
                          alert_row(2, resolved_at=iso(utcnow())),
                          alert_row(3, acknowledged_at=iso(utcnow()), acknowledged_by="admin@test.ph")])
    assert cloud.fake.sent == []


def test_many_alerts_at_once_become_one_summary(cloud):
    subscribe(cloud)
    upload_alerts(cloud, [alert_row(i, code=c, severity=s) for i, (c, s) in enumerate(
        [("SENSOR_STALE", "medium"), ("LOW_WATER", "high"), ("SENSOR_STALE", "medium"), ("POWER_OUTAGE", "medium")], 1)])
    assert cloud.fake.titles() == ["4 new greenhouse alerts"]
    d = cloud.fake.sent[0][1]
    assert d["body"].startswith("Reservoir low, ") and "Power cut" in d["body"] and d["severity"] == "high"


def test_urgent_only_devices_skip_lesser_alerts(cloud):
    subscribe(cloud, "viewer@test.ph", level="urgent")
    upload_alerts(cloud, [alert_row(1, code="SENSOR_STALE", severity="medium")])
    assert cloud.fake.sent == []
    upload_alerts(cloud, [alert_row(2, code="ESTOP", severity="critical")])
    assert cloud.fake.titles() == ["Emergency stop"]


def test_gone_devices_are_removed_and_inactive_accounts_get_nothing(cloud):
    _, a = subscribe(cloud, "admin@test.ph", n=1)
    subscribe(cloud, "viewer@test.ph", n=2)
    cloud.fake.status[a["endpoint"]] = 410
    upload_alerts(cloud, [alert_row(1)])
    with cloud.db.session() as s:
        assert s.query(PushSubscription).count() == 1
        s.query(User).filter_by(email="viewer@test.ph").one().active = False
    n = len(cloud.fake.sent)
    upload_alerts(cloud, [alert_row(2)])
    assert len(cloud.fake.sent) == n


def test_a_failing_push_service_keeps_the_device(cloud):
    _, a = subscribe(cloud)
    cloud.fake.status[a["endpoint"]] = 500
    upload_alerts(cloud, [alert_row(1)])
    with cloud.db.session() as s:
        row = s.query(PushSubscription).one()
        assert row.failures == 1 and "500" in row.last_error


# ── the controller going quiet ──────────────────────────────────────────────
def test_controller_silence_and_return(cloud):
    subscribe(cloud)
    clock = {"now": utcnow()}
    cloud.push._now = lambda: clock["now"]

    def beat(at):
        cloud.db.kv_set(cloudmod.CONTROLLER_STATUS_KEY, json.dumps({"online": True, "ts": iso(at), "cycle_s": 30}))

    beat(clock["now"])
    assert cloud.push.check_controller() is None                       # reporting: nothing to say
    clock["now"] += timedelta(minutes=4)
    assert cloud.push.check_controller() is None                       # 4 min: still within the allowance
    clock["now"] += timedelta(minutes=2)
    m = cloud.push.check_controller()
    assert m.title == "Greenhouse controller not reporting" and "(6 min)" in m.body
    clock["now"] += timedelta(minutes=10)
    assert cloud.push.check_controller() is None                       # said once
    beat(clock["now"])
    m = cloud.push.check_controller()
    assert m.title == "Greenhouse controller reporting again" and "silent for about 16 min" in m.body
    assert cloud.fake.titles() == ["Greenhouse controller not reporting", "Greenhouse controller reporting again"]
    assert {d["tag"] for _, d in cloud.fake.sent} == {"controller-status"}   # the second replaces the first


def test_long_silent_controller_is_not_announced_on_first_look(cloud):
    subscribe(cloud)
    cloud.db.kv_set(cloudmod.CONTROLLER_STATUS_KEY, json.dumps({"online": True, "ts": iso(utcnow() - timedelta(days=3))}))
    assert cloud.push.check_controller() is None and cloud.fake.sent == []


def test_real_sender_signs_and_encrypts(monkeypatch, tmp_path):
    """The production sender (pywebpush) posts an encrypted body with a VAPID header for our key."""
    import requests
    seen = {}

    def fake_post(url, timeout=None, **params):
        seen.update(url=url, headers=params["headers"], data=params["data"])
        r = requests.Response()
        r.status_code = 201
        return r

    monkeypatch.setattr(requests, "post", fake_post)
    cl = Rig(tmp_path, role="cloud")
    private, public = pushmod.generate_keys()
    cl.settings.vapid_private_key, cl.settings.vapid_subject = private, "https://greenhouse.example.com"
    svc = pushmod.PushService(cl.db, cl.settings, cl.reg)          # the real sender
    svc.subscribe(1, browser_sub(), "all", "test")
    out = svc.deliver(pushmod.Message(title="Power cut", body="x", severity="critical"))
    assert out == {"sent": 1, "removed": 0, "failed": 0}
    h = {k.lower(): v for k, v in seen["headers"].items()}
    assert seen["url"].startswith("https://fcm.googleapis.com/")
    assert h["content-encoding"] == "aes128gcm" and h["urgency"] == "high" and int(h["ttl"]) == pushmod.TTL_S
    assert f"k={public}" in h["authorization"] and h["authorization"].startswith("vapid t=")
    assert b"Power cut" not in seen["data"]                          # encrypted
