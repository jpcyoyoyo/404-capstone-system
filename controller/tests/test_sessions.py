"""Sign-ins that ended too early (19 Nov 2026): clock differences between the Pi and the cloud,
account changes made on the cloud being undone by the Pi's next upload, and one person's
Sign out ending everyone's session on a shared account."""
from __future__ import annotations

from datetime import timedelta

import jwt
from sqlalchemy import select

from greenhouse.models import User
from greenhouse.services.sync import SyncService
from greenhouse.timeutil import utcnow

from .test_api import Rig

EPOCH = utcnow().replace(year=1970, month=1, day=1, hour=0, minute=0, second=0, microsecond=0)


def token(secret, *, kind="access", ver=0, issued=timedelta(0), lasts=timedelta(minutes=30), sub="1", role="admin"):
    """A token as another server would make it, `issued` from now (positive: that server's clock is ahead)."""
    now = utcnow() + issued
    return jwt.encode({"sub": sub, "role": role, "typ": kind, "ver": ver,
                       "iat": int((now - EPOCH).total_seconds()), "exp": int((now + lasts - EPOCH).total_seconds())},
                      secret, algorithm="HS256")


def bearer(t):
    return {"Authorization": f"Bearer {t}"}


def version(db, email="admin@test.ph"):
    with db.session() as s:
        return s.execute(select(User).where(User.email == email)).scalars().one().token_version


def linked(tmp_path):
    """A Pi and a cloud server, with the Pi's sync posting straight into the cloud's API."""
    pi, cloud = Rig(tmp_path), Rig(tmp_path, role="cloud")

    def post(table, rows):
        r = cloud.client.post("/sync/ingest", json={"table": table, "rows": rows}, headers=bearer("sync-tok"))
        assert r.status_code == 200, r.text
        return r.json()

    svc = SyncService(pi.db, "http://cloud", "sync-tok", post=post)
    svc.sync_once()
    return pi, cloud, svc


# ── clocks ──────────────────────────────────────────────────────────────────
def test_a_token_from_a_server_whose_clock_is_ahead_still_works(tmp_path):
    pi = Rig(tmp_path)
    ahead = token("test-secret", issued=timedelta(minutes=20))         # e.g. the Pi slow after a power cut
    assert pi.client.get("/auth/me", headers=bearer(ahead)).status_code == 200
    refresh = token("test-secret", kind="refresh", issued=timedelta(hours=3), lasts=timedelta(days=14))
    assert pi.client.post("/auth/refresh", json={"refresh_token": refresh}).status_code == 200


def test_expiry_allows_a_few_minutes_of_clock_difference_but_no_more(tmp_path):
    pi = Rig(tmp_path)
    just = token("test-secret", issued=timedelta(minutes=-32))          # expired 2 min ago by this clock
    assert pi.client.get("/auth/me", headers=bearer(just)).status_code == 200
    old = token("test-secret", issued=timedelta(minutes=-40))           # expired 10 min ago
    assert pi.client.get("/auth/me", headers=bearer(old)).status_code == 401


# ── account changes made on the cloud ───────────────────────────────────────
def test_signing_out_everywhere_on_the_cloud_is_not_undone_by_the_next_upload(tmp_path):
    pi, cloud, svc = linked(tmp_path)
    on_pi = pi.login()                                                  # this phone signed in at home
    h = cloud.login()
    assert cloud.client.post("/auth/logout", json={"everywhere": True}, headers=h).status_code == 200
    v = version(cloud.db)
    svc.sync_once()
    assert version(cloud.db) == v and version(pi.db) == v               # the Pi took the sign-out over
    assert pi.client.get("/auth/me", headers=on_pi).status_code == 401  # signed out everywhere, as asked
    again = cloud.login()                                               # sign in again on the cloud
    svc.sync_once()
    svc.sync_once()
    assert cloud.client.get("/auth/me", headers=again).status_code == 200   # stays signed in
    assert pi.client.get("/auth/me", headers=again).status_code == 200      # and on the Pi


def test_a_password_changed_on_the_cloud_reaches_the_pi(tmp_path):
    pi, cloud, svc = linked(tmp_path)
    r = cloud.client.post("/auth/password", json={"current_password": "password123", "new_password": "newpassword9"},
                          headers=cloud.login())
    assert r.status_code == 200, r.text
    fresh = bearer(r.json()["access_token"])
    svc.sync_once()
    svc.sync_once()
    for server in (cloud, pi):
        assert server.client.post("/auth/login", json={"email": "admin@test.ph", "password": "newpassword9"}).status_code == 200
        assert server.client.post("/auth/login", json={"email": "admin@test.ph", "password": "password123"}).status_code == 401
    assert cloud.client.get("/auth/me", headers=fresh).status_code == 200


def test_changes_on_the_pi_still_reach_the_cloud(tmp_path):
    pi, cloud, svc = linked(tmp_path)
    on_cloud = cloud.login()
    assert pi.client.post("/auth/logout", json={"everywhere": True}, headers=pi.login()).status_code == 200
    svc.sync_once()
    assert version(cloud.db) == version(pi.db)
    assert cloud.client.get("/auth/me", headers=on_cloud).status_code == 401


def test_a_newer_token_works_before_the_change_has_synced(tmp_path):
    pi = Rig(tmp_path)
    v = version(pi.db)
    newer = token("test-secret", ver=v + 1)                              # issued on the cloud after a sign-out there
    assert pi.client.get("/auth/me", headers=bearer(newer)).status_code == 200
    old = token("test-secret", ver=v)
    refresh = token("test-secret", kind="refresh", ver=v + 1, lasts=timedelta(days=14))
    assert pi.client.post("/auth/refresh", json={"refresh_token": refresh}).status_code == 200
    assert version(pi.db) == v + 1                                       # the Pi now knows of the sign-out
    assert pi.client.get("/auth/me", headers=bearer(old)).status_code == 401


def test_accounts_are_added_on_the_pi_not_the_cloud(tmp_path):
    cloud = Rig(tmp_path, role="cloud")
    r = cloud.client.post("/users", json={"email": "new@test.ph", "name": "New", "password": "password123"},
                          headers=cloud.login())
    assert r.status_code == 409 and "greenhouse controller" in r.json()["detail"]


# ── signing out one device, or all of them ───────────────────────────────────
def test_sign_out_ends_only_this_device(tmp_path):
    pi = Rig(tmp_path)
    phone, laptop = pi.login(), pi.login()                               # two teammates on one account
    r = pi.client.post("/auth/logout", headers=phone)
    assert r.status_code == 200 and r.json()["everywhere"] is False
    assert pi.client.get("/auth/me", headers=phone).status_code == 401
    assert pi.client.get("/auth/me", headers=laptop).status_code == 200


def test_a_signed_out_device_cannot_renew(tmp_path):
    pi = Rig(tmp_path)
    t = pi.client.post("/auth/login", json={"email": "admin@test.ph", "password": "password123"}).json()
    renewed = pi.client.post("/auth/refresh", json={"refresh_token": t["refresh_token"]}).json()
    assert jwt.decode(renewed["access_token"], options={"verify_signature": False})["sid"] == \
        jwt.decode(t["access_token"], options={"verify_signature": False})["sid"]       # the same device
    pi.client.post("/auth/logout", headers=bearer(renewed["access_token"]))
    assert pi.client.post("/auth/refresh", json={"refresh_token": t["refresh_token"]}).status_code == 401


def test_sign_out_of_all_devices(tmp_path):
    pi = Rig(tmp_path)
    phone, laptop = pi.login(), pi.login()
    r = pi.client.post("/auth/logout", json={"everywhere": True}, headers=phone)
    assert r.json()["everywhere"] is True
    assert pi.client.get("/auth/me", headers=phone).status_code == 401
    assert pi.client.get("/auth/me", headers=laptop).status_code == 401
    assert pi.client.get("/auth/me", headers=pi.login()).status_code == 200       # signing in again works


def test_a_device_signed_out_on_either_server_is_signed_out_on_both(tmp_path):
    pi, cloud, svc = linked(tmp_path)
    a, b, other = pi.login(), cloud.login(), pi.login()
    pi.client.post("/auth/logout", headers=a)                          # signed out at home
    cloud.client.post("/auth/logout", headers=b)                       # signed out away
    svc.sync_once()
    for server in (pi, cloud):
        assert server.client.get("/auth/me", headers=a).status_code == 401
        assert server.client.get("/auth/me", headers=b).status_code == 401
        assert server.client.get("/auth/me", headers=other).status_code == 200


def test_old_tokens_without_a_session_id_still_work_and_get_one(tmp_path):
    pi = Rig(tmp_path)
    v = version(pi.db)
    assert pi.client.get("/auth/me", headers=bearer(token("test-secret", ver=v))).status_code == 200
    r = pi.client.post("/auth/refresh", json={"refresh_token": token("test-secret", kind="refresh", ver=v,
                                                                      lasts=timedelta(days=14))})
    assert jwt.decode(r.json()["access_token"], options={"verify_signature": False})["sid"]


def test_admin_edits_sign_out_only_on_a_new_password_or_when_asked(tmp_path):
    pi = Rig(tmp_path)
    admin, viewer = pi.login(), pi.login("viewer@test.ph")
    uid = pi.client.get("/auth/me", headers=viewer).json()["id"]
    assert pi.client.patch(f"/users/{uid}", json={"name": "Renamed", "role": "admin"}, headers=admin).status_code == 200
    assert pi.client.get("/auth/me", headers=viewer).status_code == 200            # still signed in
    assert pi.client.get("/users", headers=viewer).status_code == 200              # and an admin at once
    assert pi.client.patch(f"/users/{uid}", json={"role": "viewer"}, headers=admin).status_code == 200
    assert pi.client.get("/users", headers=viewer).status_code == 403              # a viewer again at once
    assert pi.client.patch(f"/users/{uid}", json={"sign_out": True}, headers=admin).status_code == 200
    assert pi.client.get("/auth/me", headers=viewer).status_code == 401
    viewer = pi.login("viewer@test.ph")
    assert pi.client.patch(f"/users/{uid}", json={"password": "another12"}, headers=admin).status_code == 200
    assert pi.client.get("/auth/me", headers=viewer).status_code == 401


def test_signed_out_devices_are_forgotten_once_their_tokens_have_expired(tmp_path):
    from greenhouse.models import RevokedSession
    from greenhouse.services import sync as syncmod
    pi, cloud, svc = linked(tmp_path)
    with pi.db.session() as s:
        s.add(RevokedSession(sid="old", user_id=1, revoked_at=utcnow() - timedelta(days=20),
                             expires_at=utcnow() - timedelta(days=5)))
    svc.sync_once()
    with pi.db.session() as s, cloud.db.session() as c:
        assert s.get(RevokedSession, "old") is None and c.get(RevokedSession, "old") is None
    assert syncmod.ingest_revocations(cloud.db, []) == (0, [])


def test_a_cloud_server_not_yet_updated_does_not_stop_the_upload(tmp_path):
    import urllib.error
    pi = Rig(tmp_path)
    sent = []

    def post(table, rows):
        if table == "revoked_sessions":            # an older cloud: "table revoked_sessions is not replicated"
            raise urllib.error.HTTPError("http://cloud/sync/ingest", 422, "Unprocessable", None, None)
        sent.append(table)

    pi.cycle()                                      # some readings to upload after the small tables
    SyncService(pi.db, "http://cloud", "sync-tok", post=post).sync_once()
    assert "users" in sent and "sensor_readings" in sent
