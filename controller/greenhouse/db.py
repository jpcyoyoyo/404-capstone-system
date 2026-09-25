from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import create_engine, event, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from .models import Base, KeyValue
from .timeutil import utcnow


class Database:
    def __init__(self, url: str):
        kwargs: dict = {"future": True, "pool_pre_ping": True}
        if url.startswith("sqlite"):
            kwargs["connect_args"] = {"check_same_thread": False, "timeout": 30}
        else:
            kwargs["pool_recycle"] = 1800
        self.url = url
        self.engine: Engine = create_engine(url, **kwargs)
        if url.startswith("sqlite"):
            @event.listens_for(self.engine, "connect")
            def _sqlite_pragmas(dbapi_conn, _):  # pragma: no cover - trivial
                cur = dbapi_conn.cursor()
                cur.execute("PRAGMA journal_mode=WAL")
                cur.execute("PRAGMA foreign_keys=ON")
                cur.close()
        self._factory = sessionmaker(bind=self.engine, expire_on_commit=False, future=True)

    def create_all(self) -> None:
        Base.metadata.create_all(self.engine)

    @contextmanager
    def session(self) -> Iterator[Session]:
        s = self._factory()
        try:
            yield s
            s.commit()
        except Exception:
            s.rollback()
            raise
        finally:
            s.close()

    # ── key/value helpers ────────────────────────────────────────────────
    def kv_get(self, key: str, default: str | None = None) -> str | None:
        with self.session() as s:
            row = s.get(KeyValue, key)
            return row.value if row else default

    def kv_set(self, key: str, value: str) -> None:
        with self.session() as s:
            row = s.get(KeyValue, key)
            if row:
                row.value = value
                row.updated_at = utcnow()
            else:
                s.add(KeyValue(key=key, value=value, updated_at=utcnow()))


def first(session: Session, stmt):
    return session.execute(stmt).scalars().first()


__all__ = ["Database", "first", "select"]
