"""Security event log.

`await security_event("auth.login_failed", "warning", request=request, subject=email)` writes one
structured JSON line to the `kritvia.security` logger (collected with the container logs) and one
row to `security_events` (append-only; see migration 0027). It never raises: logging must not
break the request it describes. Email addresses are never stored: `subject` is replaced by a
keyed hash, so repeated attempts on one address can be correlated without keeping the address.

A noisy source can't flood the table: each (kind, ip) pair writes at most 20 rows a minute; the
JSON log line is always written.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time
import uuid
from typing import Any, Literal

from fastapi import Request
from sqlalchemy import text

log = logging.getLogger("kritvia.security")
Severity = Literal["info", "warning", "critical"]
_window: dict[tuple[str, str], tuple[int, int]] = {}
PER_MINUTE = 20


def subject_hash(value: str | None) -> str | None:
    if not value:
        return None
    from kritvia_api.config import get_settings
    key = get_settings().jwt_secret.encode()
    return "h:" + hmac.new(key, b"security-subject:" + value.strip().lower().encode(), hashlib.sha256).hexdigest()[:32]


def _ip(request: Request | None) -> str | None:
    if request is None:
        return None
    from kritvia_api.ratelimit import client_ip
    return client_ip(request)


def _allowed(kind: str, ip: str | None) -> bool:
    minute = int(time.time() // 60)
    key = (kind, ip or "-")
    m, n = _window.get(key, (minute, 0))
    if m != minute:
        m, n = minute, 0
    _window[key] = (m, n + 1)
    if len(_window) > 20_000:
        for k in [k for k, v in _window.items() if v[0] != minute]:
            _window.pop(k, None)
    return n < PER_MINUTE


async def security_event(kind: str, severity: Severity = "info", /, *, request: Request | None = None,
                         ip: str | None = None, user_id: uuid.UUID | None = None, org_id: uuid.UUID | None = None,
                         subject: str | None = None, **details: Any) -> None:
    ip = ip or _ip(request)
    subj = subject_hash(subject)
    safe = {k: (v if isinstance(v, (int, float, bool)) or v is None else str(v)[:200]) for k, v in details.items()}
    line = {"event": kind, "severity": severity, "ip": ip, "user_id": str(user_id) if user_id else None,
            "org_id": str(org_id) if org_id else None, "subject": subj, **safe}
    (log.warning if severity != "info" else log.info)(json.dumps(line, separators=(",", ":")))
    if not _allowed(kind, ip):
        return
    try:
        from kritvia_api.db.session import tenant_tx
        async with tenant_tx(None, "system") as conn:
            await conn.execute(text("SELECT security_event(:k, :s, :ip, :u, :o, :sub, CAST(:d AS jsonb))"),
                               {"k": kind, "s": severity, "ip": ip, "u": user_id, "o": org_id, "sub": subj,
                                "d": json.dumps(safe)})
    except Exception:   # never let logging break the request
        log.exception("could not store security event %s", kind)
