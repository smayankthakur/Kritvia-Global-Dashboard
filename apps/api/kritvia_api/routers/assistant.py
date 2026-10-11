"""The general assistant ("Ask Kritvia") and the business's connected apps (MCP).

Assistant requests are ordinary workflow runs (workflows/assistant.py). A person sees only their own
requests here: what they asked, the steps the assistant took and its answer, read from the encrypted
run state. Drafts it made wait on the board like every other agent's.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.engine.runner import STATE_PURPOSE, DuplicateTrigger, start_run
from kritvia_api.errors import raise_for_db
from kritvia_api.services import mcp
from kritvia_api.services.crypto import EnvelopeCrypto
from kritvia_api.services.quota import PlanRestricted, require_integration

router = APIRouter(tags=["assistant"])


class AskIn(BaseModel):
    request: str = Field(min_length=2, max_length=4000)


class AssistantStep(BaseModel):
    n: int
    tool: str
    result: Literal["done", "failed", "not approved", "waiting for approval"]


class AssistantItem(BaseModel):
    run_id: uuid.UUID
    status: str
    outcome: str | None
    request: str
    answer: str | None
    steps: list[AssistantStep]
    pending_approval_id: uuid.UUID | None
    created_at: datetime
    finished_at: datetime | None


ITEM_SQL = ("SELECT r.id, r.status, r.outcome, r.state_enc, r.created_at, r.finished_at,"
            " (SELECT a.id FROM approvals a WHERE a.run_id = r.id AND a.status = 'pending'"
            "  ORDER BY a.created_at DESC LIMIT 1) AS pending_id"
            " FROM workflow_runs r WHERE r.venture_id = :v AND r.workflow = 'assistant' AND r.started_by = :u")


async def _item(crypto: EnvelopeCrypto, venture_id: uuid.UUID, r) -> AssistantItem:
    state = json.loads(await crypto.decrypt(venture_id, STATE_PURPOSE, r.state_enc))
    steps = []
    for e in state.get("log", []):
        if e.get("status") == "rejected":
            res = "not approved"
        else:
            res = "done" if e.get("ok") else "failed"
        steps.append(AssistantStep(n=int(e.get("n", 0)), tool=str(e.get("tool", ""))[:80], result=res))
    pending = state.get("pending")
    if pending and r.pending_id:
        steps.append(AssistantStep(n=int(pending.get("n", 0)), tool=str(pending.get("tool", ""))[:80],
                                   result="waiting for approval"))
    return AssistantItem(run_id=r.id, status=r.status, outcome=r.outcome,
                         request=str((state.get("input") or {}).get("request", "")),
                         answer=state.get("answer"), steps=steps, pending_approval_id=r.pending_id,
                         created_at=r.created_at, finished_at=r.finished_at)


@router.post("/ventures/{venture_id}/assistant", response_model=AssistantItem, status_code=201)
async def ask(venture_id: uuid.UUID, body: AskIn, user_id: UserId, svc: Svc, db: TenantDB) -> AssistantItem:
    try:
        run_id = await start_run(svc, actor_user_id=user_id, venture_id=venture_id, workflow="assistant",
                                 input={"request": body.request.strip()}, title="Assistant request",
                                 trigger_kind="manual")
    except LookupError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "venture not found") from None
    except ValueError as exc:
        raise HTTPException(402 if isinstance(exc, PlanRestricted) else 422, str(exc)) from None
    except DuplicateTrigger:
        raise HTTPException(status.HTTP_409_CONFLICT, "already asked") from None
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    return await get_item(venture_id, run_id, user_id, svc, db)


@router.get("/ventures/{venture_id}/assistant", response_model=list[AssistantItem])
async def list_items(venture_id: uuid.UUID, user_id: UserId, svc: Svc, db: TenantDB,
                     limit: int = 20) -> list[AssistantItem]:
    rows = (await db.execute(text(ITEM_SQL + " ORDER BY r.created_at DESC LIMIT :l"),
                             {"v": venture_id, "u": user_id, "l": min(max(limit, 1), 50)})).all()
    crypto = EnvelopeCrypto(db, svc.keys)
    return [await _item(crypto, venture_id, r) for r in rows]


@router.get("/ventures/{venture_id}/assistant/{run_id}", response_model=AssistantItem)
async def get_item(venture_id: uuid.UUID, run_id: uuid.UUID, user_id: UserId, svc: Svc,
                   db: TenantDB) -> AssistantItem:
    r = (await db.execute(text(ITEM_SQL + " AND r.id = :id"), {"v": venture_id, "u": user_id, "id": run_id})).first()
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "request not found")
    return await _item(EnvelopeCrypto(db, svc.keys), venture_id, r)


# ------------------------------------------------------------------------- connected apps --
class AppIn(BaseModel):
    name: str = Field(pattern=r"^[a-z][a-z0-9_]{1,23}$", description="short name, e.g. hubspot")
    url: str = Field(min_length=10, max_length=500)
    token: str | None = Field(default=None, max_length=4000)


class AppTool(BaseModel):
    name: str
    description: str
    read_only: bool


class AppOut(BaseModel):
    id: uuid.UUID
    name: str
    url: str
    status: str
    has_token: bool
    tools: list[AppTool]
    last_error: str | None
    updated_at: datetime


APP_COLS = "id, name, url, status, token_enc IS NOT NULL AS has_token, tools, last_error, updated_at"


def _app(r) -> AppOut:
    return AppOut(id=r.id, name=r.name, url=r.url, status=r.status, has_token=r.has_token, last_error=r.last_error,
                  updated_at=r.updated_at,
                  tools=[AppTool(name=t.get("name", ""), description=t.get("description", ""),
                                 read_only=bool(t.get("read_only"))) for t in (r.tools or [])])


async def _require_admin(db, venture_id: uuid.UUID) -> None:
    await venture_org(db, venture_id)        # 404 for a business the caller can't see, before 403
    ok = (await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar()
    if not ok:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only the business's admins can manage connected apps")


@router.get("/ventures/{venture_id}/apps", response_model=list[AppOut])
async def list_apps(venture_id: uuid.UUID, db: TenantDB) -> list[AppOut]:
    rows = (await db.execute(text(f"SELECT {APP_COLS} FROM mcp_servers WHERE venture_id = :v ORDER BY name"),
                             {"v": venture_id})).all()
    return [_app(r) for r in rows]


@router.post("/ventures/{venture_id}/apps", response_model=AppOut, status_code=201)
async def add_app(venture_id: uuid.UUID, body: AppIn, user_id: UserId, svc: Svc, db: TenantDB) -> AppOut:
    org = await venture_org(db, venture_id)
    await _require_admin(db, venture_id)
    await require_integration(db, venture_id, "mcp")
    token = (body.token or "").strip() or None
    try:
        url = await mcp.check_url(body.url)
        tools = await mcp.Client(url, token).list_tools(body.name)
    except mcp.McpError as exc:
        raise HTTPException(422, f"couldn't connect: {exc}") from None
    if not tools:
        raise HTTPException(422, "the app answered but offers no tools")
    enc = await EnvelopeCrypto(db, svc.keys).encrypt(venture_id, mcp.TOKEN_PURPOSE, token) if token else None
    try:
        async with db.begin_nested():
            r = (await db.execute(text(
                "INSERT INTO mcp_servers (org_id, venture_id, name, url, token_enc, tools, created_by)"
                " VALUES (:o, :v, :n, :u, :t, CAST(:tools AS jsonb), :by)"
                f" RETURNING {APP_COLS}"),
                {"o": org, "v": venture_id, "n": body.name, "u": url, "t": enc,
                 "tools": json.dumps([mcp.tool_to_json(t) for t in tools]), "by": user_id})).first()
    except DBAPIError as exc:
        if "mcp_servers_venture_id_name_key" in str(exc):
            raise HTTPException(status.HTTP_409_CONFLICT, f"an app called {body.name!r} is already connected") from None
        raise_for_db(exc, "venture not found")
    return _app(r)


@router.post("/ventures/{venture_id}/apps/{app_id}/refresh", response_model=AppOut)
async def refresh_app(venture_id: uuid.UUID, app_id: uuid.UUID, svc: Svc, db: TenantDB) -> AppOut:
    await _require_admin(db, venture_id)
    row = (await db.execute(text("SELECT name, url, token_enc FROM mcp_servers WHERE id = :id AND venture_id = :v"),
                            {"id": app_id, "v": venture_id})).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "app not found")
    token = (await EnvelopeCrypto(db, svc.keys).decrypt(venture_id, mcp.TOKEN_PURPOSE, row.token_enc)).decode() \
        if row.token_enc else None
    try:
        tools = await mcp.Client(row.url, token).list_tools(row.name)
        sets, params = "tools = CAST(:tools AS jsonb), status = 'active', last_error = NULL", \
            {"tools": json.dumps([mcp.tool_to_json(t) for t in tools])}
    except mcp.McpError as exc:
        sets, params = "status = 'error', last_error = :e", {"e": str(exc)[:300]}
    r = (await db.execute(text(f"UPDATE mcp_servers SET {sets}, updated_at = now() WHERE id = :id"
                               f" RETURNING {APP_COLS}"), {"id": app_id, **params})).first()
    return _app(r)


@router.delete("/ventures/{venture_id}/apps/{app_id}", status_code=204)
async def remove_app(venture_id: uuid.UUID, app_id: uuid.UUID, db: TenantDB) -> None:
    await _require_admin(db, venture_id)
    res = await db.execute(text("DELETE FROM mcp_servers WHERE id = :id AND venture_id = :v"),
                           {"id": app_id, "v": venture_id})
    if res.rowcount == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "app not found")
