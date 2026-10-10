"""Cloud server set-up (required) and the network settings used by the greenhouse display."""
from __future__ import annotations

import io
import json
import urllib.error
from datetime import timedelta

import pytest

from greenhouse import cloud
from greenhouse.netctl import SimNetwork
from greenhouse.services.sync import SyncService
from greenhouse.timeutil import utcnow

from .test_api import Rig

TOKEN = "sync-tok-0123456789abcdef"


class _Resp(io.BytesIO):
    def __init__(self, status, body):
        super().__init__(body)
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def opener_for(cloud_rig):
    """Routes urllib requests to the cloud replica's TestClient."""
    def open_(req, timeout=None):
        path = req.full_url.split("://", 1)[1].split("/", 1)[1]
        headers = dict(req.header_items())
        if req.get_method() == "GET":
            r = cloud_rig.client.get("/" + path, headers=headers)
        else:
            r = cloud_rig.client.post("/" + path, content=req.data, headers=headers)
        if r.status_code >= 400:
            raise urllib.error.HTTPError(req.full_url, r.status_code, r.text, {}, None)
        return _Resp(r.status_code, r.content)
    return open_


@pytest.fixture
def rigs(tmp_path):
    pi = Rig(tmp_path)
    pi.cycle()
    cl = Rig(tmp_path, role="cloud")
    cl.settings.sync_token = TOKEN
    return pi, cl


def test_connection_test_checks_server_and_token(rigs):
    pi, cl = rigs
    ok = cloud.test_connection("https://cloud.example.com", TOKEN, opener=opener_for(cl))
    assert ok["ok"] and [s["step"] for s in ok["steps"]] == ["server", "token"]
    bad = cloud.test_connection("https://cloud.example.com", "wrong-token-000000", opener=opener_for(cl))
    assert not bad["ok"] and "refused" in bad["steps"][-1]["detail"]
    pi_as_server = cloud.test_connection("http://192.168.50.10:8000", TOKEN, opener=opener_for(pi))
    assert not pi_as_server["ok"] and "not the cloud server" in pi_as_server["steps"][0]["detail"]
    assert not cloud.test_connection("not a url", TOKEN)["ok"]


def test_setup_through_the_api_then_sync_uses_it(rigs, monkeypatch):
    pi, cl = rigs
    h = pi.login()
    assert pi.client.get("/cloud", headers=h).json()["health"] == "not_configured"
    real = cloud.test_connection
    monkeypatch.setattr(cloud, "test_connection", lambda url, token, **k: real(url, token, opener=opener_for(cl)))
    r = pi.client.put("/cloud", json={"url": "cloud.example.com", "token": "wrong-token-000000"}, headers=h)
    assert r.status_code == 422 and r.json()["test"]["ok"] is False          # nothing saved
    r = pi.client.put("/cloud", json={"url": "cloud.example.com", "token": TOKEN}, headers=h)
    assert r.status_code == 200 and r.json()["url"] == "https://cloud.example.com" and TOKEN not in json.dumps(r.json())
    v = pi.login("viewer@test.ph")
    assert pi.client.put("/cloud", json={"url": "x.example.com", "token": TOKEN}, headers=v).status_code == 403

    def post(table, rows):
        resp = cl.client.post("/sync/ingest", json={"table": table, "rows": rows}, headers={"Authorization": f"Bearer {TOKEN}"})
        assert resp.status_code == 200, resp.text
    svc = SyncService(pi.db, settings=pi.settings, post=post)
    assert svc.run_pass() > 0
    st = pi.client.get("/cloud", headers=h).json()
    assert st["health"] == "ok" and st["source"] == "app"
    from greenhouse.models import KeyValue
    with cl.db.session() as s:
        keys = {k.key for k in s.query(KeyValue).all()}
    assert not any(k.startswith("cloud:") for k in keys)                  # the token never leaves the Pi


def test_alerts_when_not_set_up_or_unreachable(rigs):
    pi, _ = rigs
    now = utcnow()
    assert cloud.alert_condition(pi.db, pi.settings, now)[0] == "CLOUD_NOT_CONFIGURED"
    cloud.save_config(pi.db, "https://cloud.example.com", TOKEN)
    assert cloud.alert_condition(pi.db, pi.settings, now, since=now) is None           # grace period after boot
    cloud.record(pi.db, ok=False, error="timed out", now=now)
    assert cloud.alert_condition(pi.db, pi.settings, now + timedelta(minutes=31), since=now)[0] == "CLOUD_UNREACHABLE"
    cloud.record(pi.db, ok=True, rows=5, now=now + timedelta(minutes=32))
    assert cloud.alert_condition(pi.db, pi.settings, now + timedelta(minutes=33), since=now) is None
    # the control service raises it when it has the settings (production)
    cloud.clear_config(pi.db)
    pi.control.settings = pi.settings
    pi.control._house_at = None
    pi.cycle()
    h = pi.login()
    assert "CLOUD_NOT_CONFIGURED" in [a["code"] for a in pi.client.get("/alerts?status=open", headers=h).json()]


def test_network_status_scan_and_change(rigs):
    pi, _ = rigs
    kiosk = {"Authorization": "Bearer " + pi.client.get("/auth/kiosk").json()["access_token"]}
    st = pi.client.get("/network", headers=kiosk).json()            # the display may read the status
    assert st["wifi"]["ssid"] and st["cloud"]["health"] == "not_configured" and st["app_urls"]
    assert pi.client.get("/network/wifi", headers=kiosk).status_code == 403     # but not change anything
    assert pi.client.post("/network/wifi", json={"ssid": "X", "password": "password1"}, headers=kiosk).status_code == 403
    v = pi.login("viewer@test.ph")
    assert pi.client.post("/network/wifi", json={"ssid": "X", "password": "password1"}, headers=v).status_code == 403
    h = pi.login()
    assert any(n["ssid"] == "MAgSO-Office" for n in pi.client.get("/network/wifi", headers=h).json())
    assert pi.client.post("/network/wifi", json={"ssid": "MAgSO-Office", "password": "short"}, headers=h).status_code == 422
    r = pi.client.post("/network/wifi", json={"profile": "magso", "ssid": "MAgSO-Office", "password": "secret-pass-1"}, headers=h)
    assert r.status_code == 200 and r.json()["connected"]
    assert pi.client.get("/network", headers=h).json()["profiles"]["magso"] == "MAgSO-Office"
    audit = json.dumps(pi.client.get("/logs?kind=audit", headers=h).json())
    assert "network_changed" in audit and "secret-pass-1" not in audit       # the password is never logged
    assert pi.client.post("/network/hotspot", headers=h).json()["ok"]


def test_sim_network_validation():
    n = SimNetwork()
    with pytest.raises(Exception):
        n.set_wifi("magso", "", "password1")
    with pytest.raises(Exception):
        n.set_wifi("magso", "x" * 33, "password1")
    assert n.set_wifi("router", "OpenNet", "")["ok"]
