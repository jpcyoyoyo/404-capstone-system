"""greenhouse-api: the REST interface for the mobile app and the kiosk (Integration Plan §8.5).

Runs on the Pi (GH_ROLE=controller) and, with GH_ROLE=cloud, as the read-mostly cloud
replica. OpenAPI docs are generated at /docs.
"""
from __future__ import annotations

import logging
import threading
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import desc, func, select, update

from .. import __version__
from ..auth import decode_token, make_token, verify_password
from ..bus import Bus, Topics
from ..calibration import two_point_fit
from ..config import Settings
from ..control.aggregate import aggregate
from ..control.types import Reading as CReading
from ..db import Database
from ..models import (Actuator, ActuatorEvent, Alert, AuditLog, Calibration, Command, FertigationDose,
                      GrowthStage, Sensor, SensorReading, SensorReading15m, Threshold, User)
from ..registry import PARAMS, Registry
from ..seed import DEFAULT_STAGE_KEY, create_user
from ..timeutil import iso, parse_iso, utcnow
from . import sync as syncmod
from .common import alert_payload

log = logging.getLogger(__name__)


# ── live cache: retained MQTT state mirrored in memory ─────────────────────
class LiveCache:
    def __init__(self, bus: Bus, topics: Topics):
        self.topics = topics
        self.readings: dict[str, dict] = {}
        self.actuators: dict[str, dict] = {}
        self.status: dict[str, Any] = {}
        self.nodes: dict[str, dict] = {}
        self._lock = threading.Lock()
        bus.subscribe(topics.reading(), self._on_reading)
        bus.subscribe(topics.actuator_state(), self._on_act)
        bus.subscribe(topics.status, self._on_status)
        bus.subscribe(topics.node_status(), self._on_node)

    def _on_reading(self, t, p):
        with self._lock:
            self.readings[p.get("sensor_id", "")] = p

    def _on_act(self, t, p):
        with self._lock:
            self.actuators[p.get("actuator_id", "")] = p

    def _on_status(self, t, p):
        with self._lock:
            self.status = p

    def _on_node(self, t, p):
        with self._lock:
            self.nodes[Topics.segment(t, 3)] = p


class AckWaiter:
    def __init__(self, bus: Bus, topics: Topics):
        self._events: dict[str, tuple[threading.Event, dict]] = {}
        self._lock = threading.Lock()
        bus.subscribe(topics.ack(), self._on_ack, qos=1)

    def expect(self, cmd_id: str) -> threading.Event:
        ev = threading.Event()
        with self._lock:
            self._events[cmd_id] = (ev, {})
        return ev

    def result(self, cmd_id: str) -> dict:
        with self._lock:
            ev, box = self._events.pop(cmd_id, (None, {}))
        return box

    def _on_ack(self, t, p):
        with self._lock:
            entry = self._events.get(p.get("cmd_id", ""))
        if entry:
            entry[1].update(p)
            entry[0].set()


# ── request bodies ──────────────────────────────────────────────────────────
class LoginIn(BaseModel):
    email: str
    password: str


class RefreshIn(BaseModel):
    refresh_token: str


class PasswordIn(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8)


class CommandBody(BaseModel):
    cmd_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    action: Literal["ON", "OFF", "AUTO", "DOSE", "ESTOP"]
    duration_s: int | None = Field(default=None, ge=1, le=12 * 3600)
    target_g: float | None = Field(default=None, gt=0, le=500)
    circuit: Literal["fog", "drip", "sprinkler"] | None = None
    reason: str = "MANUAL_OVERRIDE"
    ts: str | None = None


class ThresholdIn(BaseModel):
    parameter: str
    min: float
    max: float
    deadband: float | None = Field(default=None, ge=0)

    @field_validator("parameter")
    @classmethod
    def _known(cls, v: str) -> str:
        if v not in PARAMS:
            raise ValueError(f"unknown parameter {v}")
        return v


class StageIn(BaseModel):
    stage_id: str


class CalibrationIn(BaseModel):
    kind: Literal["dry_wet", "two_point", "scale", "raw"]
    dry: float | None = None
    wet: float | None = None
    points: list[dict[str, float]] | None = None   # [{raw, ref}, {raw, ref}] (+ optional verify point)
    offset: float | None = None
    scale: float | None = None
    known_g: float | None = None
    raw_at_known: float | None = None
    constants: dict[str, Any] | None = None
    note: str = ""


class UserIn(BaseModel):
    email: str
    name: str
    password: str = Field(min_length=8)
    role: Literal["admin", "viewer"] = "viewer"


class UserPatch(BaseModel):
    name: str | None = None
    role: Literal["admin", "viewer"] | None = None
    active: bool | None = None
    password: str | None = Field(default=None, min_length=8)


class SyncIn(BaseModel):
    table: str
    rows: list[dict[str, Any]]


class FaultIn(BaseModel):
    kind: str
    sensor_id: str | None = None
    node_id: str | None = None
    value: float | None = None
    attr: str | None = None


# ── app factory ─────────────────────────────────────────────────────────────
def create_app(settings: Settings, reg: Registry, db: Database, bus: Bus) -> FastAPI:
    topics = Topics(reg.greenhouse_id)
    cache = LiveCache(bus, topics)
    waiter = AckWaiter(bus, topics)
    is_cloud = settings.role == "cloud"

    app = FastAPI(title="Smart Greenhouse API", version=__version__,
                  description="Controller API for the IoT-Enabled Smart Greenhouse (404 Brains Not Found).")
    app.add_middleware(CORSMiddleware, allow_origins=[o.strip() for o in settings.cors_origins.split(",")],
                       allow_methods=["*"], allow_headers=["*"])

    # ── auth ────────────────────────────────────────────────────────────
    def current(authorization: str | None = Header(default=None)) -> dict:
        if not authorization or not authorization.lower().startswith("bearer "):
            raise HTTPException(401, "missing bearer token")
        try:
            claims = decode_token(settings.jwt_secret, authorization.split(" ", 1)[1])
        except Exception:
            raise HTTPException(401, "invalid or expired token")
        if claims.get("typ") != "access":
            raise HTTPException(401, "not an access token")
        if claims.get("role") != "kiosk":
            with db.session() as s:
                u = s.get(User, int(claims["sub"]))
                if not u or not u.active or u.token_version != claims.get("ver"):
                    raise HTTPException(401, "session revoked")
                claims["email"], claims["name"] = u.email, u.name
        else:
            claims["email"], claims["name"] = "kiosk", "Kiosk display"
        return claims

    def admin(user: dict = Depends(current)) -> dict:
        if user.get("role") != "admin":
            raise HTTPException(403, "administrator only")
        return user

    def reader(user: dict = Depends(current)) -> dict:
        return user

    def user_payload(u: User) -> dict:
        return {"id": u.id, "email": u.email, "name": u.name, "role": u.role, "active": u.active,
                "last_login_at": iso(u.last_login_at), "created_at": iso(u.created_at)}

    def tokens_for(u: User, request: Request | None = None) -> dict:
        access = make_token(settings.jwt_secret, sub=str(u.id), role=u.role, kind="access",
                            ttl=timedelta(minutes=settings.access_token_minutes), ver=u.token_version)
        refresh = make_token(settings.jwt_secret, sub=str(u.id), role=u.role, kind="refresh",
                             ttl=timedelta(days=settings.refresh_token_days), ver=u.token_version)
        return {"access_token": access, "refresh_token": refresh, "token_type": "bearer",
                "expires_in": settings.access_token_minutes * 60, "user": user_payload(u), "mqtt": mqtt_info(request)}

    def mqtt_info(request: Request | None = None) -> dict | None:
        if not settings.mqtt_ws_url:
            return None
        url = settings.mqtt_ws_url
        if "://auto" in url:   # the same host the app used to reach this API
            host = request.url.hostname if request is not None else "localhost"
            url = url.replace("://auto", f"://{host}")
        return {"url": url, "username": settings.mqtt_app_username,
                "password": settings.mqtt_app_password, "prefix": topics.base}

    def audit(actor: str, action: str, target: str, detail: dict | None = None) -> None:
        with db.session() as s:
            s.add(AuditLog(actor=actor, action=action, target=target, detail=detail))

    @app.post("/auth/login", tags=["auth"])
    def login(body: LoginIn, request: Request):
        with db.session() as s:
            u = s.execute(select(User).where(User.email == body.email.strip().lower())).scalars().first()
            if not u or not u.active or not verify_password(u.password_hash, body.password):
                raise HTTPException(401, "wrong email or password")
            u.last_login_at = utcnow()
            s.flush()
            out = tokens_for(u, request)
        audit(body.email.strip().lower(), "login", "auth")
        return out

    @app.post("/auth/refresh", tags=["auth"])
    def refresh(body: RefreshIn, request: Request):
        try:
            claims = decode_token(settings.jwt_secret, body.refresh_token)
        except Exception:
            raise HTTPException(401, "invalid or expired refresh token")
        if claims.get("typ") != "refresh":
            raise HTTPException(401, "not a refresh token")
        with db.session() as s:
            u = s.get(User, int(claims["sub"]))
            if not u or not u.active or u.token_version != claims.get("ver"):
                raise HTTPException(401, "session revoked")
            return tokens_for(u, request)

    @app.post("/auth/logout", tags=["auth"])
    def logout(user: dict = Depends(current)):
        """Revokes every session for this user (all devices)."""
        if user.get("role") != "kiosk":
            with db.session() as s:
                u = s.get(User, int(user["sub"]))
                u.token_version += 1
        return {"ok": True}

    @app.get("/auth/me", tags=["auth"])
    def me(user: dict = Depends(current)):
        return {"id": user["sub"], "email": user["email"], "name": user["name"], "role": user["role"]}

    @app.post("/auth/password", tags=["auth"])
    def change_password(body: PasswordIn, request: Request, user: dict = Depends(current)):
        """Change your own password. Signs out your other devices and returns fresh tokens."""
        from ..auth import hash_password
        if user.get("role") == "kiosk":
            raise HTTPException(403, "the kiosk has no password")
        with db.session() as s:
            u = s.get(User, int(user["sub"]))
            if not verify_password(u.password_hash, body.current_password):
                raise HTTPException(400, "current password is wrong")
            u.password_hash = hash_password(body.new_password)
            u.token_version += 1
            s.flush()
            out = tokens_for(u, request)
        audit(user["email"], "password_changed", f"user:{user['email']}")
        return out

    @app.get("/auth/kiosk", tags=["auth"])
    def kiosk_token(request: Request, token: str | None = None):
        """Read-only token for the local display. Only from the Pi itself, or with GH_KIOSK_TOKEN."""
        host = request.client.host if request.client else ""
        if host not in ("127.0.0.1", "::1", "localhost", "testclient") and not (settings.kiosk_token and token == settings.kiosk_token):
            raise HTTPException(403, "kiosk token is only issued on the controller")
        access = make_token(settings.jwt_secret, sub="kiosk", role="kiosk", kind="access", ttl=timedelta(days=30))
        return {"access_token": access, "token_type": "bearer", "mqtt": mqtt_info(request)}

    # ── meta and live ───────────────────────────────────────────────────
    @app.get("/health", tags=["meta"])
    def health():
        st = cache.status
        age = None
        if st.get("ts"):
            age = (utcnow() - (parse_iso(st["ts"]) or utcnow())).total_seconds()
        return {"ok": True, "role": settings.role, "version": __version__, "controller_online": bool(st.get("online")),
                "controller_status_age_s": age, "server_time": iso(utcnow())}

    def sensor_rows() -> dict[str, Sensor]:
        with db.session() as s:
            return {r.id: r for r in s.execute(select(Sensor)).scalars().all()}

    @app.get("/greenhouse", tags=["meta"])
    def greenhouse(user: dict = Depends(reader)):
        rows = sensor_rows()
        with db.session() as s:
            stages = s.execute(select(GrowthStage).order_by(GrowthStage.sequence)).scalars().all()
            stage_list = [{"id": g.id, "name": g.name, "sequence": g.sequence, "irrigation_mode": g.irrigation_mode,
                           "description": g.description} for g in stages]
        return {
            "id": reg.greenhouse_id, "name": reg.greenhouse_name, "timezone": reg.timezone, "role": settings.role,
            "capabilities": {**reg.capabilities, "remote_commands": reg.capabilities.get("remote_commands", False) if is_cloud else True},
            "network_mode": cache.status.get("network_mode", settings.network_mode),
            "active_stage": db.kv_get(DEFAULT_STAGE_KEY), "stages": stage_list,
            "zones": [{"id": z.id, "name": z.name, "description": z.description} for z in reg.zones],
            "nodes": [{"id": n.id, "board": n.board, "zone": n.zone} for n in reg.nodes],
            "sensors": [{"id": sd.id, "type": sd.type, "zone": sd.zone, "host": sd.host, "unit": sd.unit,
                         "installed": sd.installed, "calibration": sd.calibration,
                         "calibrated_at": iso(rows[sd.id].calibrated_at) if sd.id in rows else None}
                        for sd in reg.sensors],
            "actuators": [{"id": a.id, "name": a.name, "group": a.group, "kind": a.kind, "installed": a.installed,
                           "water": a.water, "manual_only": a.manual_only, "virtual": a.virtual, "circuit": a.circuit}
                          for a in reg.actuators],
            "control": {"cycle_s": reg.control.get("cycle_s", 30), "command_expiry_s": reg.control.get("command_expiry_s", 60),
                        "manual_override_max_s": reg.control.get("manual_override_max_s", 1800),
                        "photoperiod": reg.control.get("photoperiod")},
            "server_time": iso(utcnow()),
        }

    def live_readings() -> dict[str, dict]:
        readings = dict(cache.readings)
        missing = [sd.id for sd in reg.sensors if sd.installed and sd.id not in readings]
        if missing:  # e.g. the cloud replica, or right after an API restart
            with db.session() as s:
                sub = (select(SensorReading.sensor_id, func.max(SensorReading.id).label("mid"))
                       .where(SensorReading.sensor_id.in_(missing)).group_by(SensorReading.sensor_id).subquery())
                rows = s.execute(select(SensorReading).join(sub, SensorReading.id == sub.c.mid)).scalars().all()
                for r in rows:
                    sd = reg.sensor(r.sensor_id)
                    readings[r.sensor_id] = {"sensor_id": r.sensor_id, "zone_id": sd.zone, "type": sd.type, "value": r.value,
                                             "unit": r.unit, "raw": r.raw, "quality": r.quality, "ts": iso(r.recorded_at)}
        # Age out: a reading older than 3 cycles is shown as STALE, never as live.
        stale_s = 3 * max(30.0, float(reg.control.get("cycle_s", 30)))
        now = utcnow()
        for sid, p in readings.items():
            ts = parse_iso(p.get("ts"))
            sd = reg.sensor(sid) if reg.has_sensor(sid) else None
            limit = stale_s * max(1, (sd.interval_s if sd else 30) / 30)
            if ts and (now - ts).total_seconds() > limit and p.get("quality") != "STALE":
                readings[sid] = {**p, "quality": "STALE", "value": None, "last_value": p.get("value")}
        return readings

    def zone_summary(readings: dict[str, dict]) -> dict:
        creadings = {sid: CReading(sid, p.get("type", ""), int(p.get("zone_id", 0)), p.get("value"), p.get("quality", ""),
                                   parse_iso(p.get("ts")) or utcnow()) for sid, p in readings.items()}
        params = aggregate(reg, creadings, list(PARAMS) + ["water_level", "water_temperature", "hopper_weight", "water_flow"])
        return {t: {"value": ps.value, "manual_required": ps.manual_required_zones,
                    "zones": {str(z): {"median": zv.median, "valid": zv.n_valid, "total": zv.n_total} for z, zv in ps.zones.items()}}
                for t, ps in params.items()}

    def actuators_live() -> dict[str, dict]:
        out = dict(cache.actuators)
        with db.session() as s:
            for a in s.execute(select(Actuator)).scalars().all():
                if a.id not in out:
                    out[a.id] = {"actuator_id": a.id, "on": a.state, "mode": a.mode, "installed": a.installed,
                                 "lockout": None if a.installed else "NOT_INSTALLED", "since": iso(a.last_changed),
                                 "manual_until": None, "reason": None, "ts": None}
        return out

    def controller_status() -> dict:
        st = dict(cache.status)
        ts = parse_iso(st.get("ts"))
        cycle = float(st.get("cycle_s") or reg.control.get("cycle_s", 30))
        st["online"] = bool(st.get("online")) and ts is not None and (utcnow() - ts).total_seconds() < 3 * cycle + 5
        return st

    @app.get("/greenhouse/{gid}/live", tags=["live"])
    def live(gid: str, user: dict = Depends(reader)):
        readings = live_readings()
        st = controller_status()
        return {"greenhouse_id": reg.greenhouse_id, "server_time": iso(utcnow()), "active_stage": db.kv_get(DEFAULT_STAGE_KEY),
                "controller": {"online": st.get("online", False), "ts": st.get("ts"), "network_mode": st.get("network_mode"),
                               "nodes": st.get("nodes", {})},
                "readings": readings, "zones": zone_summary(readings), "actuators": actuators_live(),
                "alerts_open": open_alert_count()}

    @app.get("/greenhouse/{gid}/actuators", tags=["live"])
    def actuators(gid: str, user: dict = Depends(reader)):
        return list(actuators_live().values())

    @app.get("/greenhouse/{gid}/history", tags=["live"])
    def history(gid: str, user: dict = Depends(reader), sensor: str | None = None, type: str | None = None,
                zone: int | None = None, frm: str | None = Query(default=None, alias="from"), to: str | None = None,
                resolution: Literal["raw", "15m", "1h", "1d"] = "15m", limit: int = Query(default=5000, le=20000)):
        t1 = parse_iso(to) or utcnow()
        t0 = parse_iso(frm) or (t1 - timedelta(hours=24))
        ids = [s.id for s in reg.sensors if (sensor is None or s.id == sensor) and (type is None or s.type == type)
               and (zone is None or s.zone == zone)]
        if not ids:
            raise HTTPException(404, "no sensor matches")
        with db.session() as s:
            raw = s.execute(select(SensorReading.sensor_id, SensorReading.recorded_at, SensorReading.value, SensorReading.quality)
                            .where(SensorReading.sensor_id.in_(ids), SensorReading.recorded_at >= t0, SensorReading.recorded_at <= t1)
                            .order_by(SensorReading.recorded_at).limit(limit if resolution == "raw" else 200000)).all()
            agg = s.execute(select(SensorReading15m).where(SensorReading15m.sensor_id.in_(ids),
                                                           SensorReading15m.bucket_start >= t0,
                                                           SensorReading15m.bucket_start <= t1)).scalars().all()
        if resolution == "raw":
            series: dict[str, list] = {}
            for sid, t, v, q in raw:
                series.setdefault(sid, []).append({"ts": iso(t), "value": v, "quality": q})
            return {"from": iso(t0), "to": iso(t1), "resolution": "raw", "series": series}
        width = {"15m": 900, "1h": 3600, "1d": 86400}[resolution]
        buckets: dict[tuple[str, int], list[float]] = {}
        for sid, t, v, q in raw:
            if q == "VALID" and v is not None:
                buckets.setdefault((sid, int((t - datetime(1970, 1, 1)).total_seconds()) // width), []).append(v)
        for a in agg:
            b = int((a.bucket_start - datetime(1970, 1, 1)).total_seconds()) // width
            buckets.setdefault((a.sensor_id, b), []).extend([a.avg_value] * max(1, a.samples))
        series = {}
        for (sid, b), vals in sorted(buckets.items(), key=lambda kv: kv[0][1]):
            series.setdefault(sid, []).append({"ts": iso(datetime(1970, 1, 1) + timedelta(seconds=b * width)),
                                               "value": round(sum(vals) / len(vals), 3), "min": min(vals), "max": max(vals),
                                               "n": len(vals)})
        return {"from": iso(t0), "to": iso(t1), "resolution": resolution, "series": series}

    # ── commands ────────────────────────────────────────────────────────
    @app.post("/actuator/{aid}/command", tags=["control"])
    def command(aid: str, body: CommandBody, user: dict = Depends(admin)):
        now = utcnow()
        if is_cloud and not reg.capabilities.get("remote_commands", False):
            return {"cmd_id": body.cmd_id, "status": "REJECTED", "reason": "REMOTE_READ_ONLY",
                    "message": "Commands are only available on the greenhouse network for now.", "ts": iso(now)}
        if aid != "all" and not reg.has_actuator(aid):
            raise HTTPException(404, f"no actuator '{aid}'")
        if body.action == "ESTOP" and aid != "all":
            raise HTTPException(400, "ESTOP is sent to /actuator/all/command")
        issued = parse_iso(body.ts) or now
        with db.session() as s:
            existing = s.get(Command, body.cmd_id)
            if existing is not None:
                if existing.status in ("ACCEPTED", "REJECTED", "EXPIRED"):
                    return {"cmd_id": existing.cmd_id, "status": existing.status, "reason": existing.status_reason,
                            "message": existing.message, "ts": iso(existing.resolved_at), "replayed": True}
            else:
                s.add(Command(cmd_id=body.cmd_id, actuator_id=aid, action=body.action, duration_s=body.duration_s,
                              target_g=body.target_g, circuit=body.circuit, issued_by=user["email"], reason=body.reason,
                              status="PENDING", issued_at=issued, received_at=now))
        ev = waiter.expect(body.cmd_id)
        payload = {"cmd_id": body.cmd_id, "actuator_id": aid, "action": body.action, "duration_s": body.duration_s,
                   "target_g": body.target_g, "circuit": body.circuit, "issued_by": user["email"], "reason": body.reason,
                   "ts": iso(issued)}
        bus.publish(topics.cmd(aid), payload, qos=1)
        if ev.wait(settings.ack_timeout_s):
            return waiter.result(body.cmd_id)
        # No ack in time: expire the row so the controller can never execute it late.
        with db.session() as s:
            expired = s.execute(update(Command).where(Command.cmd_id == body.cmd_id, Command.status == "PENDING")
                                .values(status="EXPIRED", status_reason="CONTROLLER_TIMEOUT",
                                        message="controller did not respond", resolved_at=utcnow())).rowcount
        if not expired and ev.wait(5):   # the controller claimed it just in time
            return waiter.result(body.cmd_id)
        waiter.result(body.cmd_id)
        with db.session() as s:
            row = s.get(Command, body.cmd_id)
            return {"cmd_id": body.cmd_id, "status": row.status if row.status != "PROCESSING" else "EXPIRED",
                    "reason": row.status_reason or "CONTROLLER_TIMEOUT", "message": row.message, "ts": iso(utcnow())}

    @app.get("/commands/{cmd_id}", tags=["control"])
    def command_status(cmd_id: str, user: dict = Depends(reader)):
        with db.session() as s:
            c = s.get(Command, cmd_id)
            if not c:
                raise HTTPException(404, "unknown command")
            return {"cmd_id": c.cmd_id, "actuator_id": c.actuator_id, "action": c.action, "status": c.status,
                    "reason": c.status_reason, "message": c.message, "issued_by": c.issued_by, "issued_at": iso(c.issued_at),
                    "resolved_at": iso(c.resolved_at)}

    # ── thresholds and stage ────────────────────────────────────────────
    def thresholds_for(stage: str) -> list[dict]:
        with db.session() as s:
            rows = s.execute(select(Threshold).where(Threshold.stage_id == stage)).scalars().all()
        units = reg.raw.get("sensor_defaults", {}).get("units", {})
        order = {p: i for i, p in enumerate(PARAMS)}
        return sorted([{"parameter": t.parameter, "min": t.min_value, "max": t.max_value, "deadband": t.deadband,
                        "unit": units.get(t.parameter, ""), "version": t.version, "updated_at": iso(t.updated_at),
                        "updated_by": t.updated_by} for t in rows], key=lambda d: order.get(d["parameter"], 99))

    @app.get("/thresholds/{stage}", tags=["config"])
    def get_thresholds(stage: str, user: dict = Depends(reader)):
        try:
            reg.stage(stage)
        except KeyError:
            raise HTTPException(404, "unknown stage")
        return thresholds_for(stage)

    @app.put("/thresholds/{stage}", tags=["config"])
    def put_thresholds(stage: str, body: list[ThresholdIn], user: dict = Depends(admin)):
        if is_cloud:
            raise HTTPException(409, "thresholds are edited on the greenhouse network")
        try:
            reg.stage(stage)
        except KeyError:
            raise HTTPException(404, "unknown stage")
        plaus = reg.raw.get("sensor_defaults", {}).get("plausible", {})
        for t in body:
            if t.min >= t.max:
                raise HTTPException(422, f"{t.parameter}: min must be below max")
            lo, hi = plaus.get(t.parameter, [-1e9, 1e9])
            if t.min < lo or t.max > hi:
                raise HTTPException(422, f"{t.parameter}: must be within {lo}–{hi}")
        changed = []
        with db.session() as s:
            for t in body:
                row = s.execute(select(Threshold).where(Threshold.stage_id == stage, Threshold.parameter == t.parameter)).scalars().first()
                old = {"min": row.min_value, "max": row.max_value, "deadband": row.deadband} if row else None
                if row is None:
                    row = Threshold(stage_id=stage, parameter=t.parameter, min_value=t.min, max_value=t.max,
                                    deadband=t.deadband if t.deadband is not None else reg.deadbands.get(t.parameter, 0),
                                    updated_by=user["email"])
                    s.add(row)
                elif (row.min_value, row.max_value, row.deadband) != (t.min, t.max, t.deadband if t.deadband is not None else row.deadband):
                    row.min_value, row.max_value = t.min, t.max
                    if t.deadband is not None:
                        row.deadband = t.deadband
                    row.version += 1
                    row.updated_at, row.updated_by = utcnow(), user["email"]
                else:
                    continue
                changed.append({"parameter": t.parameter, "old": old, "new": {"min": t.min, "max": t.max, "deadband": row.deadband},
                                "version": row.version})
        for c in changed:
            audit(user["email"], "threshold_updated", f"threshold:{stage}:{c['parameter']}", c)
        if changed:
            bus.publish(topics.config_changed, {"what": "thresholds", "stage": stage, "ts": iso(utcnow())}, qos=1)
        return thresholds_for(stage)

    @app.get("/greenhouse/{gid}/stage", tags=["config"])
    def get_stage(gid: str, user: dict = Depends(reader)):
        return {"stage_id": db.kv_get(DEFAULT_STAGE_KEY)}

    @app.put("/greenhouse/{gid}/stage", tags=["config"])
    def put_stage(gid: str, body: StageIn, user: dict = Depends(admin)):
        if is_cloud:
            raise HTTPException(409, "the growth stage is changed on the greenhouse network")
        try:
            reg.stage(body.stage_id)
        except KeyError:
            raise HTTPException(404, "unknown stage")
        old = db.kv_get(DEFAULT_STAGE_KEY)
        db.kv_set(DEFAULT_STAGE_KEY, body.stage_id)
        audit(user["email"], "stage_changed", "greenhouse:stage", {"old": old, "new": body.stage_id})
        bus.publish(topics.config_changed, {"what": "stage", "stage": body.stage_id, "ts": iso(utcnow())}, qos=1)
        return {"stage_id": body.stage_id}

    # ── alerts ──────────────────────────────────────────────────────────
    def open_alert_count() -> int:
        with db.session() as s:
            return s.execute(select(func.count()).select_from(Alert).where(Alert.acknowledged_at.is_(None),
                                                                            Alert.resolved_at.is_(None))).scalar() or 0

    @app.get("/alerts", tags=["alerts"])
    def alerts(user: dict = Depends(reader), status: Literal["open", "all", "unacknowledged"] = "all",
               limit: int = Query(default=100, le=1000), severity: str | None = None):
        with db.session() as s:
            q = select(Alert).order_by(desc(Alert.raised_at)).limit(limit)
            if status == "open":
                q = q.where(Alert.resolved_at.is_(None))
            elif status == "unacknowledged":
                q = q.where(Alert.acknowledged_at.is_(None))
            if severity:
                q = q.where(Alert.severity == severity)
            return [alert_payload(a) for a in s.execute(q).scalars().all()]

    @app.get("/alerts/{alert_id}", tags=["alerts"])
    def alert(alert_id: int, user: dict = Depends(reader)):
        with db.session() as s:
            a = s.get(Alert, alert_id)
            if not a:
                raise HTTPException(404, "unknown alert")
            return {**alert_payload(a), "last_seen_at": iso(a.last_seen_at), "detail": a.detail}

    @app.post("/alerts/{alert_id}/ack", tags=["alerts"])
    def ack_alert(alert_id: int, user: dict = Depends(admin)):
        with db.session() as s:
            a = s.get(Alert, alert_id)
            if not a:
                raise HTTPException(404, "unknown alert")
            if a.acknowledged_at is None:
                a.acknowledged_at, a.acknowledged_by = utcnow(), user["email"]
                if (a.detail or {}).get("kind") == "event":
                    a.resolved_at = a.resolved_at or utcnow()
            out = alert_payload(a)
        audit(user["email"], "alert_acknowledged", f"alert:{alert_id}", {"code": out["code"]})
        return out

    # ── logs, reports ───────────────────────────────────────────────────
    @app.get("/logs", tags=["logs"])
    def logs(user: dict = Depends(reader), kind: Literal["audit", "events"] = "audit",
             frm: str | None = Query(default=None, alias="from"), to: str | None = None,
             actuator: str | None = None, limit: int = Query(default=200, le=2000)):
        t1 = parse_iso(to) or utcnow()
        t0 = parse_iso(frm) or (t1 - timedelta(days=30))
        with db.session() as s:
            if kind == "audit":
                rows = s.execute(select(AuditLog).where(AuditLog.occurred_at.between(t0, t1))
                                 .order_by(desc(AuditLog.occurred_at)).limit(limit)).scalars().all()
                return [{"id": r.id, "actor": r.actor, "action": r.action, "target": r.target, "detail": r.detail,
                         "occurred_at": iso(r.occurred_at)} for r in rows]
            q = select(ActuatorEvent).where(ActuatorEvent.occurred_at.between(t0, t1))
            if actuator:
                q = q.where(ActuatorEvent.actuator_id == actuator)
            rows = s.execute(q.order_by(desc(ActuatorEvent.occurred_at)).limit(limit)).scalars().all()
            return [{"id": r.id, "actuator_id": r.actuator_id, "action": r.action, "reason": r.reason, "source": r.source,
                     "issued_by": r.issued_by, "cmd_id": r.cmd_id, "duration_s": r.duration_s, "detail": r.detail,
                     "occurred_at": iso(r.occurred_at)} for r in rows]

    @app.get("/reports/water-usage", tags=["reports"])
    def water_usage(user: dict = Depends(reader), days: int = Query(default=7, ge=1, le=90)):
        """Litres per local day, from the flow sensor when installed, else estimated from pump run time."""
        t0 = utcnow() - timedelta(days=days)
        from ..timeutil import local_time_of
        per_day: dict[str, dict] = {}
        flow = [s for s in reg.sensors_of("water_flow")]
        with db.session() as s:
            if flow:
                rows = s.execute(select(SensorReading.recorded_at, SensorReading.value).where(
                    SensorReading.sensor_id == flow[0].id, SensorReading.recorded_at >= t0,
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
                ActuatorEvent.occurred_at >= t0).order_by(ActuatorEvent.occurred_at)).all()
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

    @app.get("/reports/fertilizer", tags=["reports"])
    def fertilizer(user: dict = Depends(reader), days: int = Query(default=30, ge=1, le=365)):
        t0 = utcnow() - timedelta(days=days)
        with db.session() as s:
            doses = s.execute(select(FertigationDose).where(FertigationDose.started_at >= t0)
                              .order_by(desc(FertigationDose.started_at))).scalars().all()
            items = [{"id": d.id, "target_g": d.target_g, "delivered_g": d.delivered_g, "status": d.status, "reason": d.reason,
                      "source": d.source, "issued_by": d.issued_by, "started_at": iso(d.started_at),
                      "finished_at": iso(d.finished_at),
                      "error_g": round(d.delivered_g - d.target_g, 2) if d.delivered_g is not None else None} for d in doses]
        complete = [i for i in items if i["status"] == "complete"]
        errs = [abs(i["error_g"]) for i in complete if i["error_g"] is not None]
        return {"doses": items, "count": len(items), "complete": len(complete),
                "total_delivered_g": round(sum(i["delivered_g"] or 0 for i in items), 1),
                "mean_abs_error_g": round(sum(errs) / len(errs), 2) if errs else None}

    # ── calibration ─────────────────────────────────────────────────────
    @app.get("/calibration", tags=["calibration"])
    def calibrations(user: dict = Depends(reader)):
        rows = sensor_rows()
        with db.session() as s:
            last = {}
            for c in s.execute(select(Calibration).order_by(Calibration.performed_at)).scalars().all():
                last[c.sensor_id] = c
        now = utcnow()
        out = []
        for sd in reg.sensors:
            if sd.calibration == "none":
                continue
            c = last.get(sd.id)
            out.append({"sensor_id": sd.id, "type": sd.type, "zone": sd.zone, "kind": sd.calibration, "installed": sd.installed,
                        "calibrated_at": iso(c.performed_at) if c else None, "performed_by": c.performed_by if c else None,
                        "days_since": (now - c.performed_at).days if c else None, "constants": c.constants if c else None,
                        "latest_raw": cache.readings.get(sd.id, {}).get("raw")})
        return out

    @app.post("/calibration/{sensor_id}", tags=["calibration"])
    def calibrate(sensor_id: str, body: CalibrationIn, user: dict = Depends(admin)):
        if not reg.has_sensor(sensor_id):
            raise HTTPException(404, "unknown sensor")
        sd = reg.sensor(sensor_id)
        try:
            if body.kind == "raw":
                consts = dict(body.constants or {})
            elif body.kind == "dry_wet":
                if body.dry is None or body.wet is None:
                    raise ValueError("dry and wet are required")
                if abs(body.dry - body.wet) < 100:
                    raise ValueError("dry and wet readings are too close — check the probe")
                consts = {"dry": body.dry, "wet": body.wet}
            elif body.kind == "two_point":
                pts = body.points or []
                if len(pts) < 2:
                    raise ValueError("two buffer points are required")
                div = float(sd.extra.get("divider", 1.0))
                consts = two_point_fit(pts[0]["raw"] * div, pts[0]["ref"], pts[1]["raw"] * div, pts[1]["ref"])
                consts["kind"] = sd.type
                if len(pts) > 2:   # verification point (e.g. pH 9.18)
                    v = consts["slope"] * pts[2]["raw"] * div + consts["intercept"]
                    consts["verify"] = {"ref": pts[2]["ref"], "measured": round(v, 3), "error": round(v - pts[2]["ref"], 3)}
            elif body.kind == "scale":
                if body.known_g and body.raw_at_known is not None and body.offset is not None:
                    consts = {"offset": body.offset, "scale": (body.raw_at_known - body.offset) / body.known_g}
                elif body.scale:
                    consts = {"offset": body.offset or 0.0, "scale": body.scale}
                else:
                    raise ValueError("give offset, known_g and raw_at_known (or offset and scale)")
            else:
                raise ValueError("unsupported calibration kind")
        except (ValueError, KeyError, ZeroDivisionError) as e:
            raise HTTPException(422, str(e))
        now = utcnow()
        with db.session() as s:
            s.add(Calibration(sensor_id=sensor_id, constants=consts, performed_by=user["email"], performed_at=now, note=body.note))
            row = s.get(Sensor, sensor_id)
            if row:
                row.calibrated_at = now
        audit(user["email"], "sensor_calibrated", f"sensor:{sensor_id}", consts)
        bus.publish(topics.config_changed, {"what": "calibration", "sensor_id": sensor_id, "ts": iso(now)}, qos=1)
        return {"sensor_id": sensor_id, "constants": consts, "calibrated_at": iso(now)}

    # ── users ───────────────────────────────────────────────────────────
    @app.get("/users", tags=["users"])
    def users(user: dict = Depends(admin)):
        with db.session() as s:
            return [user_payload(u) for u in s.execute(select(User).order_by(User.id)).scalars().all()]

    @app.post("/users", tags=["users"])
    def add_user(body: UserIn, user: dict = Depends(admin)):
        try:
            u = create_user(db, body.email, body.password, body.name, body.role)
        except ValueError as e:
            raise HTTPException(422, str(e))
        audit(user["email"], "user_saved", f"user:{body.email.lower()}", {"role": body.role})
        return user_payload(u)

    @app.patch("/users/{uid}", tags=["users"])
    def patch_user(uid: int, body: UserPatch, user: dict = Depends(admin)):
        from ..auth import hash_password
        with db.session() as s:
            u = s.get(User, uid)
            if not u:
                raise HTTPException(404, "unknown user")
            if str(uid) == user["sub"] and (body.role == "viewer" or body.active is False):
                raise HTTPException(409, "you cannot demote or deactivate yourself")
            if body.name is not None:
                u.name = body.name
            if body.role is not None:
                u.role = body.role
            if body.active is not None:
                u.active = body.active
            if body.password:
                u.password_hash = hash_password(body.password)
            u.token_version += 1   # any change signs the user out everywhere
            out = user_payload(u)
        audit(user["email"], "user_updated", f"user:{out['email']}", body.model_dump(exclude={"password"}, exclude_none=True))
        return out

    # ── cloud replica ingest ────────────────────────────────────────────
    @app.post("/sync/ingest", tags=["sync"])
    def sync_ingest(body: SyncIn, authorization: str | None = Header(default=None)):
        if not is_cloud:
            raise HTTPException(404, "only the cloud replica accepts sync")
        if not settings.sync_token or authorization != f"Bearer {settings.sync_token}":
            raise HTTPException(401, "bad sync token")
        try:
            n = syncmod.ingest(db, body.table, body.rows)
        except ValueError as e:
            raise HTTPException(422, str(e))
        if body.table == "sensor_readings" and body.rows:
            for r in body.rows[-200:]:
                sid = r.get("sensor_id")
                if reg.has_sensor(sid):
                    sd = reg.sensor(sid)
                    cache.readings[sid] = {"sensor_id": sid, "zone_id": sd.zone, "type": sd.type, "value": r.get("value"),
                                           "unit": r.get("unit"), "raw": r.get("raw"), "quality": r.get("quality"),
                                           "ts": iso(parse_iso(r.get("recorded_at")))}
        return {"ok": True, "rows": n}

    # ── dev: fault injection ────────────────────────────────────────────
    if settings.enable_sim_api:
        @app.post("/sim/fault", tags=["sim"])
        def sim_fault(body: FaultIn, user: dict = Depends(admin)):
            """Dev only (GH_ENABLE_SIM_API=1): inject a fault into the simulated greenhouse."""
            bus.publish(f"{topics.base}/sim/fault", body.model_dump(exclude_none=True), qos=1)
            audit(user["email"], "sim_fault", "sim", body.model_dump(exclude_none=True))
            return {"ok": True}

    # ── kiosk / static web build ────────────────────────────────────────
    if settings.web_root and Path(settings.web_root).is_dir():
        root = Path(settings.web_root).resolve()

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str):
            f = (root / path).resolve()
            if path and f.is_file() and root in f.parents:
                return FileResponse(f)
            return FileResponse(root / "index.html")

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception):  # pragma: no cover
        log.exception("unhandled error on %s", request.url.path)
        return JSONResponse({"detail": "internal error"}, status_code=500)

    app.state.cache = cache
    return app
