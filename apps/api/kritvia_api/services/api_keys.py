"""API keys: let a business's own systems use Kritvia's API (Scale and Enterprise).

A key looks like `kvk_` + 43 random characters and is sent as `Authorization: Bearer kvk_…`. It acts as
the owner who made it, but only:

  * on that organisation (its businesses' paths, checked against the database),
  * on the endpoints below: reading leads, invoices, bookings, proposals, approvals, automations and
    analytics; with a write key also adding and updating leads, adding invoices and payments, and
    adding bookings (never deleting, never billing, members, keys, connections or settings),
  * while the organisation's plan includes API access and the maker is still its owner.

Each key is limited to 120 requests a minute. Keys are stored only as SHA-256 hashes and shown once.
"""
from __future__ import annotations

import hashlib
import re
import secrets
import uuid

from fastapi import HTTPException, Request, status
from sqlalchemy import text

from kritvia_api.db.session import tenant_tx
from kritvia_api.plans import plan as plan_of

PREFIX = "kvk_"
U = r"[0-9a-fA-F-]{36}"
V = rf"^/ventures/(?P<v>{U})"
READ = [re.compile(p) for p in (
    rf"{V}/(leads|invoices|bookings|proposals|approvals|automations)(/{U})?/?$",
    rf"{V}/analytics/?$",
    rf"{V}/invoices/{U}/document/?$",
    rf"^/orgs/(?P<o>{U})/ventures/?$",
)]
WRITE = {
    "POST": [re.compile(p) for p in (rf"{V}/leads/?$", rf"{V}/invoices/?$", rf"{V}/invoices/{U}/payment/?$",
                                     rf"{V}/bookings/?$")],
    "PATCH": [re.compile(p) for p in (rf"{V}/leads/{U}/?$",)],
}


def new_key() -> tuple[str, str, str]:
    """(the key to show once, its 12-character prefix for recognising it, its hash to store)."""
    key = PREFIX + secrets.token_urlsafe(32)
    return key, key[:12], hash_key(key)


def hash_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def _match(method: str, path: str, scope: str) -> re.Match | None:
    if method in ("GET", "HEAD"):
        return next((m for p in READ if (m := p.match(path))), None)
    if scope != "write":
        return None
    return next((m for p in WRITE.get(method, []) if (m := p.match(path))), None)


async def user_for_key(request: Request, key: str) -> uuid.UUID:
    """The user a request made with an API key acts as; refuses anything the key may not do."""
    from kritvia_api.ratelimit import limiter

    h = hash_key(key)
    await limiter.hit(f"api-key:{h[:20]}", per_minute=120)
    async with tenant_tx(None) as conn:
        k = (await conn.execute(text("SELECT * FROM api_key_auth(:h)"), {"h": h})).first()
    if k is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid or revoked API key")
    if "api_access" not in plan_of(k.plan or None).extras:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED,
                            "API access is part of the Scale and Enterprise plans; this organisation's plan doesn't include it")
    m = _match(request.method.upper(), request.url.path, k.scope)
    if m is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "API keys can't use this endpoint" + ("" if k.scope == "write" else " (this key is read-only)"))
    groups = m.groupdict()
    if groups.get("o"):
        same = groups["o"].lower() == str(k.org_id)
    else:
        async with tenant_tx(k.user_id) as conn:
            org = (await conn.execute(text("SELECT org_id FROM ventures WHERE id = :v AND removed_at IS NULL"),
                                      {"v": groups["v"]})).scalar()
        same = org == k.org_id
    if not same:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not found")
    request.state.api_key_id = k.key_id
    return k.user_id
