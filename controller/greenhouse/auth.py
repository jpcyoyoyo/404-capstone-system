"""Password hashing and JWT tokens."""
from __future__ import annotations

from datetime import timedelta
from typing import Any

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

from .timeutil import utcnow

_ph = PasswordHasher()


def hash_password(password: str) -> str:
    return _ph.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _ph.verify(password_hash, password)
    except (VerifyMismatchError, InvalidHashError):
        return False


def make_token(secret: str, *, sub: str, role: str, kind: str, ttl: timedelta, ver: int = 0,
               extra: dict[str, Any] | None = None) -> str:
    now = utcnow()
    payload = {"sub": sub, "role": role, "typ": kind, "ver": ver,
               "iat": int((now - _EPOCH).total_seconds()), "exp": int((now + ttl - _EPOCH).total_seconds())}
    if extra:
        payload.update(extra)
    return jwt.encode(payload, secret, algorithm="HS256")


def decode_token(secret: str, token: str) -> dict[str, Any]:
    return jwt.decode(token, secret, algorithms=["HS256"])


from datetime import datetime as _dt  # noqa: E402

_EPOCH = _dt(1970, 1, 1)
