from __future__ import annotations

import re
import uuid
from collections.abc import AsyncIterator
from typing import Annotated

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncConnection

from kritvia_api.db.session import tenant_tx
from kritvia_api.engine.context import Services, get_services
from kritvia_api.security import decode_access_token, token_issued_at

_bearer = HTTPBearer(auto_error=False)


async def current_user_id(
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> uuid.UUID:
    if creds is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing bearer token")
    try:
        user_id = decode_access_token(creds.credentials)
        iat = token_issued_at(creds.credentials)
    except (jwt.PyJWTError, ValueError):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid or expired token") from None
    from sqlalchemy import text
    async with tenant_tx(user_id) as conn:
        # Deactivated users and tokens issued before a password change stop working at
        # once, not when the access token expires.
        ok = (await conn.execute(
            text("SELECT is_active AND NOT is_service AND extract(epoch FROM password_changed_at) <= :iat + 1"
                 " FROM users WHERE id = :u"), {"u": user_id, "iat": iat})).scalar()
    if not ok:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "session no longer valid")
    return user_id


_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "DELETE"})   # deleting is always allowed (erasure)
_SCOPED = re.compile(r"^/(ventures|orgs)/([0-9a-fA-F-]{36})(?:/|$)")
_ALWAYS_OPEN = re.compile(r"^/orgs/[^/]+/(billing|plan)(?:/|$)")   # choosing a plan must work


async def tenant_db(request: Request,
                    user_id: Annotated[uuid.UUID, Depends(current_user_id)]) -> AsyncIterator[AsyncConnection]:
    async with tenant_tx(user_id) as conn:
        await _refuse_writes_after_trial(conn, request)
        yield conn


async def _refuse_writes_after_trial(conn: AsyncConnection, request: Request) -> None:
    """An organisation whose free trial ended without a plan is read-only: every change to its
    businesses or settings answers 402, except choosing a plan and deleting things."""
    if request.method in _SAFE_METHODS:
        return
    path = request.url.path
    m = _SCOPED.match(path)
    if not m or _ALWAYS_OPEN.match(path):
        return
    from kritvia_api.services.quota import READ_ONLY_MESSAGE, read_only
    try:
        ident = uuid.UUID(m.group(2))
    except ValueError:
        return
    scope = {"venture_id": ident} if m.group(1) == "ventures" else {"org_id": ident}
    if await read_only(conn, **scope):
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, READ_ONLY_MESSAGE)


async def anonymous_db() -> AsyncIterator[AsyncConnection]:
    async with tenant_tx(None) as conn:
        yield conn


def services_dep() -> Services:
    return get_services()


async def venture_org(db: AsyncConnection, venture_id: uuid.UUID) -> uuid.UUID:
    """The venture's org id, or 404 if the caller cannot see the venture (RLS)."""
    from sqlalchemy import text
    org = (await db.execute(text("SELECT org_id FROM ventures WHERE id = :v AND removed_at IS NULL"), {"v": venture_id})).scalar()
    if org is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "venture not found")
    return org


UserId = Annotated[uuid.UUID, Depends(current_user_id)]
TenantDB = Annotated[AsyncConnection, Depends(tenant_db)]
AnonDB = Annotated[AsyncConnection, Depends(anonymous_db)]
Svc = Annotated[Services, Depends(services_dep)]
