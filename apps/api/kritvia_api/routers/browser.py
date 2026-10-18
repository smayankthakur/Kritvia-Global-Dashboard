"""Browser agent jobs (workflows/browser.py).

  GET   /ventures/{v}/browser/status     is it available here (server set up, plan, switched on)
  POST  /ventures/{v}/browser            give it a job: {task, url?}
  GET   /ventures/{v}/browser            your recent jobs (task, answer, pages used, form waiting)
  GET   /ventures/{v}/browser/{run_id}   one of them

Like assistant requests, a person sees the jobs they gave. Forms wait on the approval board.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.engine.runner import PAYLOAD_PURPOSE, STATE_PURPOSE, start_run
from kritvia_api.errors import raise_for_db
from kritvia_api.ratelimit import limiter
from kritvia_api.services.crypto import EnvelopeCrypto
from kritvia_api.services.quota import PlanRestricted, plan_for_venture

router = APIRouter(tags=["browser"])


class BrowserJobIn(BaseModel):
    task: str = Field(min_length=5, max_length=1500)
    url: str | None = Field(default=None, max_length=2000)

    @field_validator("url")
    @classmethod
    def _url(cls, v: str | None) -> str | None:
        v = (v or "").strip()
        if not v:
            return None
        if not v.startswith(("http://", "https://")):
            v = "https://" + v
        return v


class BrowserField(BaseModel):
    label: str
    value: str


class BrowserJob(BaseModel):
    run_id: uuid.UUID
    status: str
    outcome: str | None
    task: str
    url: str | None
    answer: str | None
    sources: list[str]
    steps: int
    form: list[BrowserField] | None = Field(default=None, description="the form waiting for a yes")
    pending_approval_id: uuid.UUID | None
    created_at: datetime
    finished_at: datetime | None


class BrowserStatus(BaseModel):
    configured: bool
    plan_includes: bool
    enabled: bool
    note: str | None


ITEM_SQL = ("SELECT r.id, r.status, r.outcome, r.state_enc, r.created_at, r.finished_at,"
            " (SELECT a.id FROM approvals a WHERE a.run_id = r.id AND a.status = 'pending'"
            "  ORDER BY a.created_at DESC LIMIT 1) AS pending_id"
            " FROM workflow_runs r WHERE r.venture_id = :v AND r.workflow = 'browser' AND r.started_by = :u")


async def _job(db, crypto: EnvelopeCrypto, venture_id: uuid.UUID, r) -> BrowserJob:
    state = json.loads(await crypto.decrypt(venture_id, STATE_PURPOSE, r.state_enc))
    inp = state.get("input") or {}
    form = None
    if r.pending_id:
        enc = (await db.execute(text("SELECT payload_enc FROM approvals WHERE id = :id"), {"id": r.pending_id})).scalar()
        if enc:
            p = json.loads(await crypto.decrypt(venture_id, PAYLOAD_PURPOSE, enc))
            form = [BrowserField(label=str(f.get("label", ""))[:120], value=str(f.get("value", ""))[:500])
                    for f in p.get("fields") or []]
    return BrowserJob(run_id=r.id, status=r.status, outcome=r.outcome, task=str(inp.get("task", "")),
                      url=inp.get("url"), answer=state.get("answer"), sources=list(state.get("sources") or [])[:8],
                      steps=int((state.get("summary") or {}).get("steps", 0)), form=form,
                      pending_approval_id=r.pending_id, created_at=r.created_at, finished_at=r.finished_at)


@router.get("/ventures/{venture_id}/browser/status", response_model=BrowserStatus)
async def browser_status(venture_id: uuid.UUID, db: TenantDB, svc: Svc) -> BrowserStatus:
    await venture_org(db, venture_id)
    kind = (await db.execute(text("SELECT coalesce(kind, 'general') FROM venture_settings WHERE venture_id = :v"),
                             {"v": venture_id})).scalar() or "general"
    p = await plan_for_venture(db, venture_id)
    enabled = (await db.execute(text("SELECT enabled FROM workflow_configs WHERE venture_id = :v AND workflow = 'browser'"),
                                {"v": venture_id})).scalar()
    configured = bool(getattr(svc.browser, "configured", False))
    includes = p.allows_agent("browser", kind)
    note = None
    if not configured:
        note = "The browser isn't set up on this server yet."
    elif not includes:
        note = f"{p.label[0].upper()}{p.label[1:]} doesn't include the browser agent; it comes with Growth."
    elif enabled is False:
        note = "The browser agent is switched off on the Agents page."
    return BrowserStatus(configured=configured, plan_includes=includes, enabled=enabled is not False, note=note)


@router.post("/ventures/{venture_id}/browser", response_model=BrowserJob, status_code=201)
async def start_job(venture_id: uuid.UUID, body: BrowserJobIn, user_id: UserId, svc: Svc, db: TenantDB) -> BrowserJob:
    await venture_org(db, venture_id)
    await limiter.hit(f"browser-job:{user_id}", per_minute=6)
    try:
        run_id = await start_run(svc, actor_user_id=user_id, venture_id=venture_id, workflow="browser",
                                 input={"task": body.task.strip(), "url": body.url}, title="Browser job",
                                 trigger_kind="manual")
    except LookupError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "venture not found") from None
    except ValueError as exc:
        raise HTTPException(402 if isinstance(exc, PlanRestricted) else 422, str(exc)) from None
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    return await get_job(venture_id, run_id, user_id, svc, db)


@router.get("/ventures/{venture_id}/browser", response_model=list[BrowserJob])
async def list_jobs(venture_id: uuid.UUID, user_id: UserId, svc: Svc, db: TenantDB, limit: int = 20) -> list[BrowserJob]:
    rows = (await db.execute(text(ITEM_SQL + " ORDER BY r.created_at DESC LIMIT :l"),
                             {"v": venture_id, "u": user_id, "l": min(max(limit, 1), 50)})).all()
    crypto = EnvelopeCrypto(db, svc.keys)
    return [await _job(db, crypto, venture_id, r) for r in rows]


@router.get("/ventures/{venture_id}/browser/{run_id}", response_model=BrowserJob)
async def get_job(venture_id: uuid.UUID, run_id: uuid.UUID, user_id: UserId, svc: Svc, db: TenantDB) -> BrowserJob:
    r = (await db.execute(text(ITEM_SQL + " AND r.id = :id"), {"v": venture_id, "u": user_id, "id": run_id})).first()
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "job not found")
    return await _job(db, EnvelopeCrypto(db, svc.keys), venture_id, r)
