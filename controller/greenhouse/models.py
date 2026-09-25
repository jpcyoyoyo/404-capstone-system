"""Database schema (Integration Plan §8.1), for MySQL 8 in production and SQLite in dev/tests.

sensor_readings is not partitioned: the retention job keeps raw rows for 7 days
(30 for pH/EC) and rolls older data into sensor_readings_15m, so the raw table
stays around 300k rows. The (sensor_id, recorded_at) index covers every query.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (JSON, BigInteger, Boolean, DateTime, Float, ForeignKey, Index, Integer, String,
                        Text, UniqueConstraint)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from .timeutil import utcnow

# BIGINT on MySQL, plain INTEGER on SQLite (so autoincrement works there too).
BigId = BigInteger().with_variant(Integer, "sqlite")


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(190), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(16), default="admin")  # admin | viewer
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    token_version: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Zone(Base):
    __tablename__ = "zones"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    name: Mapped[str] = mapped_column(String(80))
    description: Mapped[str] = mapped_column(String(255), default="")


class Sensor(Base):
    __tablename__ = "sensors"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    zone_id: Mapped[int] = mapped_column(ForeignKey("zones.id"))
    type: Mapped[str] = mapped_column(String(32))
    host: Mapped[str] = mapped_column(String(16))
    unit: Mapped[str] = mapped_column(String(16), default="")
    installed: Mapped[bool] = mapped_column(Boolean, default=True)
    status: Mapped[str] = mapped_column(String(16), default="unknown")
    calibrated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class SensorReading(Base):
    __tablename__ = "sensor_readings"
    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    sensor_id: Mapped[str] = mapped_column(String(40))
    value: Mapped[float | None] = mapped_column(Float, nullable=True)
    raw: Mapped[float | None] = mapped_column(Float, nullable=True)
    unit: Mapped[str] = mapped_column(String(16), default="")
    quality: Mapped[str] = mapped_column(String(16))
    recorded_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    __table_args__ = (Index("ix_readings_sensor_time", "sensor_id", "recorded_at"),
                      Index("ix_readings_time", "recorded_at"))


class SensorReading15m(Base):
    __tablename__ = "sensor_readings_15m"
    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    sensor_id: Mapped[str] = mapped_column(String(40))
    bucket_start: Mapped[datetime] = mapped_column(DateTime)
    avg_value: Mapped[float] = mapped_column(Float)
    min_value: Mapped[float] = mapped_column(Float)
    max_value: Mapped[float] = mapped_column(Float)
    samples: Mapped[int] = mapped_column(Integer)
    __table_args__ = (UniqueConstraint("sensor_id", "bucket_start", name="uq_15m_sensor_bucket"),)


class Actuator(Base):
    __tablename__ = "actuators"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    kind: Mapped[str] = mapped_column(String(16))
    group: Mapped[str] = mapped_column("grp", String(24))
    installed: Mapped[bool] = mapped_column(Boolean, default=True)
    state: Mapped[bool] = mapped_column(Boolean, default=False)
    mode: Mapped[str] = mapped_column(String(8), default="AUTO")
    last_changed: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class ActuatorEvent(Base):
    __tablename__ = "actuator_events"
    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    actuator_id: Mapped[str] = mapped_column(String(40), index=True)
    action: Mapped[str] = mapped_column(String(16))          # ON | OFF | DEFERRED | SUPPRESSED | MODE_AUTO | MODE_MANUAL
    reason: Mapped[str] = mapped_column(String(255), default="")
    source: Mapped[str] = mapped_column(String(16), default="auto")  # auto | manual | safety | boot
    duration_s: Mapped[float | None] = mapped_column(Float, nullable=True)
    issued_by: Mapped[str] = mapped_column(String(120), default="system")
    cmd_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    detail: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class GrowthStage(Base):
    __tablename__ = "growth_stages"
    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    name: Mapped[str] = mapped_column(String(40))
    sequence: Mapped[int] = mapped_column(Integer)
    irrigation_mode: Mapped[str] = mapped_column(String(16))
    description: Mapped[str] = mapped_column(String(255), default="")


class Threshold(Base):
    __tablename__ = "thresholds"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    stage_id: Mapped[str] = mapped_column(ForeignKey("growth_stages.id"))
    parameter: Mapped[str] = mapped_column(String(32))
    min_value: Mapped[float] = mapped_column(Float)
    max_value: Mapped[float] = mapped_column(Float)
    deadband: Mapped[float] = mapped_column(Float, default=0)
    version: Mapped[int] = mapped_column(Integer, default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_by: Mapped[str] = mapped_column(String(120), default="system")
    __table_args__ = (UniqueConstraint("stage_id", "parameter", name="uq_threshold_stage_param"),)


class Command(Base):
    __tablename__ = "commands"
    cmd_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    actuator_id: Mapped[str] = mapped_column(String(40))
    action: Mapped[str] = mapped_column(String(8))
    duration_s: Mapped[int | None] = mapped_column(Integer, nullable=True)
    target_g: Mapped[float | None] = mapped_column(Float, nullable=True)
    circuit: Mapped[str | None] = mapped_column(String(16), nullable=True)
    issued_by: Mapped[str] = mapped_column(String(120))
    reason: Mapped[str] = mapped_column(String(64), default="MANUAL_OVERRIDE")
    status: Mapped[str] = mapped_column(String(12), default="PENDING")  # PENDING ACCEPTED REJECTED EXPIRED
    status_reason: Mapped[str | None] = mapped_column(String(64), nullable=True)
    message: Mapped[str | None] = mapped_column(String(255), nullable=True)
    issued_at: Mapped[datetime] = mapped_column(DateTime)
    received_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Alert(Base):
    __tablename__ = "alerts"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    severity: Mapped[str] = mapped_column(String(10))  # low | medium | high | critical
    source: Mapped[str] = mapped_column(String(40))
    code: Mapped[str] = mapped_column(String(40))
    message: Mapped[str] = mapped_column(String(255))
    dedupe_key: Mapped[str] = mapped_column(String(100), index=True)
    raised_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    acknowledged_by: Mapped[str | None] = mapped_column(String(120), nullable=True)
    acknowledged_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    detail: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class Calibration(Base):
    __tablename__ = "calibrations"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    sensor_id: Mapped[str] = mapped_column(String(40), index=True)
    constants: Mapped[dict] = mapped_column(JSON)
    performed_by: Mapped[str] = mapped_column(String(120))
    performed_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    note: Mapped[str] = mapped_column(String(255), default="")


class AuditLog(Base):
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    actor: Mapped[str] = mapped_column(String(120))
    action: Mapped[str] = mapped_column(String(48))
    target: Mapped[str] = mapped_column(String(80))
    detail: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class FertigationDose(Base):
    __tablename__ = "fertigation_doses"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    target_g: Mapped[float] = mapped_column(Float)
    delivered_g: Mapped[float | None] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(String(16))  # complete | aborted
    reason: Mapped[str] = mapped_column(String(64), default="")
    source: Mapped[str] = mapped_column(String(16), default="manual")
    issued_by: Mapped[str] = mapped_column(String(120), default="system")
    cmd_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class KeyValue(Base):
    __tablename__ = "kv"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


# Tables replicated to the cloud, keyed by an increasing integer id.
SYNCED_APPEND_TABLES = [SensorReading, ActuatorEvent, AuditLog, FertigationDose, Calibration]
# Small tables replicated whole on every sync pass. Users travel too (password hashes only) so the
# same accounts work on the remote path; the cloud must use the same GH_JWT_SECRET as the Pi.
SYNCED_SNAPSHOT_TABLES = [Zone, Sensor, Actuator, GrowthStage, Threshold, Alert, KeyValue, User]
