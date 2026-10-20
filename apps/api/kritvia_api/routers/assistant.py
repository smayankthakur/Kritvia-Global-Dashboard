"""The general assistant ("Ask Kritvia"). Connected apps (the App store) are in routers/app_store.py.

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

from kritvia_api.deps import Svc, TenantDB, UserId
from kritvia_api.engine.runner import STATE_PURPOSE, DuplicateTrigger, start_run
from kritvia_api.errors import raise_for_db
from kritvia_api.services.crypto import EnvelopeCrypto
from kritvia_api.services.quota import PlanRestricted

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
    skill_id: uuid.UUID | None = Field(default=None, description="set when this request was a skill's run")


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
                         created_at=r.created_at, finished_at=r.finished_at,
                         skill_id=(state.get("input") or {}).get("skill_id"))


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
