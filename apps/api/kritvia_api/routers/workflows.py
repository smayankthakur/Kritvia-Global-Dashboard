"""Workflow catalogue, per-venture configuration, runs and their timelines."""
from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.engine.core import registry
from kritvia_api.engine.runner import DuplicateTrigger, cancel_run, retry_run, start_run
from kritvia_api.errors import raise_for_db
from kritvia_api.services.quota import PlanRestricted, plan_for_venture, require_agent

router = APIRouter(tags=["workflows"])


class OptionOut(BaseModel):
    key: str
    label: str
    type: Literal["boolean", "number", "text"]
    default: Any
    help: str = ""
    min: float | None = None
    max: float | None = None


class WorkflowOut(BaseModel):
    name: str
    title: str
    description: str
    trigger: str
    venture_kinds: list[str]
    steps: list[dict[str, str]]
    options: list[OptionOut]


@router.get("/workflows", response_model=list[WorkflowOut])
async def catalogue(_: UserId) -> list[WorkflowOut]:
    return [WorkflowOut(name=w.name, title=w.title, description=w.description, trigger=w.trigger,
                        venture_kinds=list(w.venture_kinds),
                        steps=[{"name": s.name, "agent": s.agent} for s in w.steps.values()],
                        options=[OptionOut(**o.__dict__) for o in w.options])
            for w in registry.all()]


@router.get("/tools", response_model=list[dict[str, str]])
async def tools(_: UserId, svc: Svc) -> list[dict[str, str]]:
    return svc.tools.catalogue()


class WorkflowConfigIn(BaseModel):
    enabled: bool = True
    schedule: str | None = Field(default=None, pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$",
                                 description="daily run time, HH:MM IST")
    settings: dict[str, Any] = Field(default_factory=dict)
    instructions: str = Field(default="", max_length=4000,
                              description="plain-language standing instructions the agent follows")


class WorkflowConfigOut(WorkflowConfigIn):
    workflow: str
    updated_at: datetime | None = None


@router.get("/ventures/{venture_id}/workflow-configs", response_model=list[WorkflowConfigOut])
async def list_configs(venture_id: uuid.UUID, db: TenantDB) -> list[WorkflowConfigOut]:
    await venture_org(db, venture_id)
    rows = (await db.execute(text(
        "SELECT workflow, enabled, schedule, settings, instructions, updated_at FROM workflow_configs"
        " WHERE venture_id = :v"
        " ORDER BY workflow"), {"v": venture_id})).all()
    return [WorkflowConfigOut(**r._mapping) for r in rows]


@router.put("/ventures/{venture_id}/workflow-configs/{workflow}", response_model=WorkflowConfigOut)
async def put_config(venture_id: uuid.UUID, workflow: str, body: WorkflowConfigIn, user_id: UserId,
                     db: TenantDB) -> WorkflowConfigOut:
    org = await venture_org(db, venture_id)
    if workflow not in registry:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown workflow")
    if not (await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "venture not found")
    if len(json.dumps(body.settings)) > 20000:
        raise HTTPException(422, "settings too large")
    if body.enabled:
        kind = (await db.execute(text("SELECT coalesce(kind, 'general') FROM venture_settings WHERE venture_id = :v"),
                                 {"v": venture_id})).scalar()
        try:
            await require_agent(db, venture_id, workflow, kind)
        except PlanRestricted as exc:
            raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, str(exc)) from None
    try:
        async with db.begin_nested():
            row = (await db.execute(text(
                "INSERT INTO workflow_configs (org_id, venture_id, workflow, enabled, schedule, settings,"
                " instructions, updated_by) VALUES (:o, :v, :w, :e, :s, CAST(:st AS jsonb), :i, :u)"
                " ON CONFLICT (venture_id, workflow) DO UPDATE SET enabled = EXCLUDED.enabled,"
                " schedule = EXCLUDED.schedule, settings = EXCLUDED.settings, instructions = EXCLUDED.instructions,"
                " updated_by = EXCLUDED.updated_by, updated_at = now()"
                " RETURNING workflow, enabled, schedule, settings, instructions, updated_at"),
                {"o": org, "v": venture_id, "w": workflow, "e": body.enabled, "s": body.schedule,
                 "st": json.dumps(body.settings), "i": body.instructions.strip(), "u": user_id})).first()
        if workflow == "prospector":
            # "Send without asking" grants the Prospector's trust, on plans where agents may act alone.
            want = bool(body.enabled and body.settings.get("send_without_asking", True))
            if want:
                want = (await plan_for_venture(db, venture_id)).autonomy
            async with db.begin_nested():
                await db.execute(text("SELECT set_prospector_autonomy(:v, :a)"), {"v": venture_id, "a": want})
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    return WorkflowConfigOut(**row._mapping)


class RunIn(BaseModel):
    workflow: str
    input: dict[str, Any] = Field(default_factory=dict)
    title: str = Field(default="", max_length=200)


class RunOut(BaseModel):
    id: uuid.UUID
    venture_id: uuid.UUID
    workflow: str
    title: str
    status: str
    current_step: str
    outcome: str | None
    trigger_kind: str
    summary: dict[str, Any]
    error: str | None
    step_count: int
    created_at: datetime
    updated_at: datetime
    finished_at: datetime | None
    pending_approvals: int = 0


RUN_COLS = ("r.id, r.venture_id, r.workflow, r.title, r.status, r.current_step, r.outcome, r.trigger_kind, r.summary,"
            " r.error, r.step_count, r.created_at, r.updated_at, r.finished_at,"
            " (SELECT count(*) FROM approvals a WHERE a.run_id = r.id AND a.status = 'pending') AS pending_approvals")


@router.post("/ventures/{venture_id}/runs", response_model=RunOut, status_code=201)
async def start(venture_id: uuid.UUID, body: RunIn, user_id: UserId, svc: Svc) -> RunOut:
    if body.workflow not in registry:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown workflow")
    try:
        run_id = await start_run(svc, actor_user_id=user_id, venture_id=venture_id, workflow=body.workflow,
                                 input=body.input, title=body.title, trigger_kind="manual")
    except LookupError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "venture not found") from None
    except ValueError as exc:
        raise HTTPException(402 if isinstance(exc, PlanRestricted) else 422, str(exc)) from None
    except DuplicateTrigger:
        raise HTTPException(status.HTTP_409_CONFLICT, "already started") from None
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    return await get_run_row(user_id, venture_id, run_id)


async def get_run_row(user_id: uuid.UUID, venture_id: uuid.UUID, run_id: uuid.UUID) -> RunOut:
    from kritvia_api.db.session import tenant_tx
    async with tenant_tx(user_id) as conn:
        row = (await conn.execute(text(f"SELECT {RUN_COLS} FROM workflow_runs r WHERE r.id = :id AND r.venture_id = :v"),
                                  {"id": run_id, "v": venture_id})).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "run not found")
    return RunOut(**row._mapping)


@router.get("/ventures/{venture_id}/runs", response_model=list[RunOut])
async def list_runs(venture_id: uuid.UUID, db: TenantDB, workflow: str | None = None,
                    status_: Literal["queued", "running", "waiting", "completed", "failed", "cancelled"] | None =
                    Query(default=None, alias="status"), limit: int = 50) -> list[RunOut]:
    q = f"SELECT {RUN_COLS} FROM workflow_runs r WHERE r.venture_id = :v"
    params: dict[str, Any] = {"v": venture_id, "l": min(max(limit, 1), 200)}
    if workflow:
        q += " AND r.workflow = :w"
        params["w"] = workflow
    if status_:
        q += " AND r.status = :s"
        params["s"] = status_
    rows = (await db.execute(text(q + " ORDER BY r.created_at DESC LIMIT :l"), params)).all()
    return [RunOut(**r._mapping) for r in rows]


class StepOut(BaseModel):
    step: str
    agent: str | None
    status: str
    note: str | None
    error: str | None
    duration_ms: int | None
    created_at: datetime


class ApprovalBrief(BaseModel):
    id: uuid.UUID
    title: str
    action: str
    agent: str
    status: str
    created_at: datetime
    decided_at: datetime | None


class RunDetailOut(RunOut):
    steps: list[StepOut]
    approvals: list[ApprovalBrief]


@router.get("/ventures/{venture_id}/runs/{run_id}", response_model=RunDetailOut)
async def run_detail(venture_id: uuid.UUID, run_id: uuid.UUID, db: TenantDB) -> RunDetailOut:
    row = (await db.execute(text(f"SELECT {RUN_COLS} FROM workflow_runs r WHERE r.id = :id AND r.venture_id = :v"),
                            {"id": run_id, "v": venture_id})).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "run not found")
    steps = (await db.execute(text(
        "SELECT step, agent, status, note, error, duration_ms, created_at FROM workflow_steps WHERE run_id = :r"
        " ORDER BY created_at"), {"r": run_id})).all()
    aps = (await db.execute(text(
        "SELECT id, title, action, agent, status, created_at, decided_at FROM approvals WHERE run_id = :r"
        " ORDER BY created_at"), {"r": run_id})).all()
    return RunDetailOut(**row._mapping, steps=[StepOut(**s._mapping) for s in steps],
                        approvals=[ApprovalBrief(**a._mapping) for a in aps])


@router.post("/ventures/{venture_id}/runs/{run_id}/cancel", response_model=RunOut)
async def cancel(venture_id: uuid.UUID, run_id: uuid.UUID, user_id: UserId) -> RunOut:
    await get_run_row(user_id, venture_id, run_id)
    try:
        ok = await cancel_run(user_id, run_id)
    except DBAPIError as exc:
        raise_for_db(exc, "run not found")
    if not ok:
        raise HTTPException(status.HTTP_409_CONFLICT, "run cannot be cancelled in its current state")
    return await get_run_row(user_id, venture_id, run_id)


@router.post("/ventures/{venture_id}/runs/{run_id}/retry", response_model=RunOut)
async def retry(venture_id: uuid.UUID, run_id: uuid.UUID, user_id: UserId, svc: Svc) -> RunOut:
    await get_run_row(user_id, venture_id, run_id)
    try:
        ok = await retry_run(user_id, run_id, svc)
    except DBAPIError as exc:
        raise_for_db(exc, "run not found")
    if not ok:
        raise HTTPException(status.HTTP_409_CONFLICT, "only failed runs can be retried")
    return await get_run_row(user_id, venture_id, run_id)


SAMPLE_ENQUIRY = {
    "from_name": "Priya Sharma", "from_email": "priya.sharma@example.com",
    "subject": "Enquiry about your services",
    "body": ("Hi, I found you online. We are a small company in Pune and want to know what you offer, roughly what "
             "it costs and how soon you could start. Could you send details or suggest a time for a quick call?\n\n"
             "Thanks,\nPriya"),
}


class SampleOut(BaseModel):
    run_id: uuid.UUID
    workflow: str


@router.post("/ventures/{venture_id}/sample-run", response_model=SampleOut, status_code=201)
async def sample_run(venture_id: uuid.UUID, user_id: UserId, svc: Svc, db: TenantDB) -> SampleOut:
    """Start a run on a made-up enquiry so a new business sees an approval within minutes.
    Nothing is sent: the reply goes to the inbox for approval and the address is example.com."""
    await venture_org(db, venture_id)
    on = {r.workflow for r in (await db.execute(text(
        "SELECT workflow FROM workflow_configs WHERE venture_id = :v AND enabled"), {"v": venture_id})).all()}
    if "inbox_assistant" in on:
        from kritvia_api.workflows.inbox import message_input
        workflow = "inbox_assistant"
        inp = message_input(channel="email", message_id=f"sample-{uuid.uuid4().hex[:8]}", **SAMPLE_ENQUIRY)
    elif "lead_triage" in on:
        workflow, inp = "lead_triage", {"source": "manual", **SAMPLE_ENQUIRY}
    else:
        raise HTTPException(status.HTTP_409_CONFLICT, "turn on the Inbox assistant or Lead triage first")
    try:
        run_id = await start_run(svc, actor_user_id=user_id, venture_id=venture_id, workflow=workflow, input=inp,
                                 title="Sample enquiry (try it)", trigger_kind="manual")
    except LookupError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "venture not found") from None
    except ValueError as exc:
        raise HTTPException(402 if isinstance(exc, PlanRestricted) else 422, str(exc)) from None
    return SampleOut(run_id=run_id, workflow=workflow)
