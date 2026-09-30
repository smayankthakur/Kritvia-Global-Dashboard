from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

from kritvia_api.config import get_settings

_hasher = PasswordHasher()
# Verified against when the email doesn't exist, so response time doesn't reveal it.
_DUMMY_HASH = _hasher.hash("kritvia-timing-equaliser")


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str | None) -> bool:
    try:
        return _hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except (VerifyMismatchError, InvalidHashError):
        return False


def issue_access_token(user_id: uuid.UUID) -> str:
    s = get_settings()
    now = datetime.now(UTC)
    payload = {
        "sub": str(user_id),
        "iat": now,
        "exp": now + timedelta(minutes=s.access_token_minutes),
        "typ": "access",
    }
    return jwt.encode(payload, s.jwt_secret, algorithm=s.jwt_algorithm)


def decode_access_token(token: str) -> uuid.UUID:
    s = get_settings()
    payload = jwt.decode(
        token, s.jwt_secret, algorithms=[s.jwt_algorithm], options={"require": ["sub", "exp", "typ"]}
    )
    if payload.get("typ") != "access":
        raise jwt.InvalidTokenError("wrong token type")
    return uuid.UUID(payload["sub"])


def token_issued_at(token: str) -> float:
    """iat of an already-validated access token (seconds since epoch)."""
    s = get_settings()
    payload = jwt.decode(token, s.jwt_secret, algorithms=[s.jwt_algorithm])
    return float(payload.get("iat", 0))
