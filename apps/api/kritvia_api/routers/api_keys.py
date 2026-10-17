"""API keys for an organisation (owners only; the plan must include API access: Scale, Enterprise).

  GET    /orgs/{org_id}/api-keys            the organisation's keys (never the keys themselves)
  POST   /orgs/{org_id}/api-keys            make one: the key is in the answer, once
  DELETE /orgs/{org_id}/api-keys/{key_id}   revoke it at once
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.config import get_settings
from kritvia_api.deps import TenantDB, UserId
from kritvia_api.errors import raise_for_db
from kritvia_api.plans import plan as plan_of
from kritvia_api.services import api_keys as ak
from kritvia_api.services.security_log import security_event

router = APIRouter(tags=["api keys"])


class ApiKeyOut(BaseModel):
    id: uuid.UUID
    name: str
    prefix: str = Field(description="the first characters of the key, to recognise it")
    scope: Literal["read", "write"]
    created_at: datetime
    last_used_at: datetime | None
    revoked_at: datetime | None


class ApiKeysOut(BaseModel):
    available: bool = Field(description="the organisation's plan includes API access")
    base_url: str
    keys: list[ApiKeyOut]


class ApiKeyIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    scope: Literal["read", "write"] = "read"


class NewApiKeyOut(ApiKeyOut):
    key: str = Field(description="shown only now; store it safely")


async def _owner(db, org_id: uuid.UUID) -> None:
    if not (await db.execute(text("SELECT :o = ANY (private.owned_orgs())"), {"o": org_id})).scalar():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "organisation not found")


async def _available(db, org_id: uuid.UUID) -> bool:
    code = (await db.execute(text("SELECT plan FROM org_plan_state(:o)"), {"o": org_id})).scalar()
    return "api_access" in plan_of(code).extras


SELECT = "SELECT id, name, prefix, scope, created_at, last_used_at, revoked_at FROM api_keys"


@router.get("/orgs/{org_id}/api-keys", response_model=ApiKeysOut)
async def list_keys(org_id: uuid.UUID, db: TenantDB) -> ApiKeysOut:
    await _owner(db, org_id)
    rows = (await db.execute(text(SELECT + " WHERE org_id = :o ORDER BY revoked_at NULLS FIRST, created_at DESC"),
                             {"o": org_id})).all()
    return ApiKeysOut(available=await _available(db, org_id), base_url=get_settings().public_api_url.rstrip("/"),
                      keys=[ApiKeyOut(**r._mapping) for r in rows])


@router.post("/orgs/{org_id}/api-keys", response_model=NewApiKeyOut, status_code=201)
async def create_key(org_id: uuid.UUID, body: ApiKeyIn, user_id: UserId, db: TenantDB, request: Request) -> NewApiKeyOut:
    await _owner(db, org_id)
    if not await _available(db, org_id):
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, "API access is part of the Scale and Enterprise plans")
    key, prefix, h = ak.new_key()
    try:
        async with db.begin_nested():
            kid = (await db.execute(text("SELECT private.api_key_create(:o, :n, :p, :h, :s)"),
                                    {"o": org_id, "n": body.name.strip(), "p": prefix, "h": h, "s": body.scope})).scalar()
    except DBAPIError as exc:
        raise_for_db(exc, "organisation not found")
        raise
    await security_event("api_key.created", "info", request=request, user_id=user_id, org_id=org_id, scope=body.scope)
    r = (await db.execute(text(SELECT + " WHERE id = :k"), {"k": kid})).first()
    return NewApiKeyOut(**r._mapping, key=key)


@router.delete("/orgs/{org_id}/api-keys/{key_id}", status_code=204)
async def revoke_key(org_id: uuid.UUID, key_id: uuid.UUID, user_id: UserId, db: TenantDB, request: Request) -> None:
    await _owner(db, org_id)
    if not (await db.execute(text("SELECT private.api_key_revoke(:k)"), {"k": key_id})).scalar():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such active key")
    await security_event("api_key.revoked", "info", request=request, user_id=user_id, org_id=org_id)
