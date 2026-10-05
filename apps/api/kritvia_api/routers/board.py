"""The board: the owner's mission, agents as roles on a small org chart with this month's
spend against the budget they set, and tickets (one per run) moving through
open -> waiting approval -> blocked -> done. Budgets are enforced in the model router."""
from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.engine.core import registry
from kritvia_api.errors import raise_for_db
from kritvia_api.services.quota import org_usage

router = APIRouter(tags=["board"])

Role = Literal["front_desk", "sales", "accounts", "ops"]
ROLE_TITLES = {"front_desk": "Front desk", "sales": "Sales", "accounts": "Accounts", "ops": "Operations",
               "owner": "You"}
# Where each agent sits on the org chart unless the owner moves it.
DEFAULT_ROLE = {"inbox_assistant": "front_desk", "lead_triage": "sales", "loan_verification": "accounts",
                "kitchen_daily": "ops", "meeting_digest": "ops"}


class RoleOut(BaseModel):
    workflow: str
    title: str
    role: str
    role_title: str
    enabled: bool
    monthly_tokens: int | None
    used_tokens: int
    cost_usd: float
    open_tickets: int
    waiting: int
    paused: bool            # budget set and used up


class TicketOut(BaseModel):
    id: uuid.UUID
    run_id: uuid.UUID | None
    workflow: str | None
    role: str
    title: str
    status: str
    note: str
    delegated_from: str | None
    cost_usd: float
    pending_approval_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
    finished_at: datetime | None


class MissionOut(BaseModel):
    id: uuid.UUID
    title: str
    note: str
    updated_at: datetime


class BoardOut(BaseModel):
    mission: MissionOut | None
    roles: list[RoleOut]
    tickets: list[TicketOut]
    month_cost_usd: float
    month_tokens: int
    budgets_editable: bool    # plan allows per-agent budgets


TICKET_COLS = ("t.id, t.run_id, t.workflow, t.role, t.title, t.status, t.note, t.delegated_from,"
               " t.created_at, t.updated_at, t.finished_at,"
               " coalesce((SELECT sum(m.cost_usd) FROM model_calls m WHERE m.ticket_id = t.id), 0) AS cost_usd,"
               " (SELECT a.id FROM approvals a WHERE a.run_id = t.run_id AND a.status = 'pending'"
               "   ORDER BY a.created_at LIMIT 1) AS pending_approval_id")


def _f(x: Decimal | float | None) -> float:
    return float(x or 0)


@router.get("/ventures/{venture_id}/board", response_model=BoardOut)
async def board(venture_id: uuid.UUID, db: TenantDB, svc: Svc) -> BoardOut:
    org = await venture_org(db, venture_id)
    local = svc.router.local_deployments()
    rows = (await db.execute(text("SELECT * FROM board_roles(:v, :l)"), {"v": venture_id, "l": local})).all()
    roles = []
    for r in rows:
        if r.workflow not in registry:
            continue
        roles.append(RoleOut(workflow=r.workflow, title=registry.get(r.workflow).title, role=r.role,
                             role_title=ROLE_TITLES.get(r.role, r.role), enabled=r.enabled,
                             monthly_tokens=r.monthly_tokens, used_tokens=int(r.used_tokens),
                             cost_usd=_f(r.cost_usd), open_tickets=int(r.open_tickets), waiting=int(r.waiting),
                             paused=r.monthly_tokens is not None and int(r.used_tokens) >= int(r.monthly_tokens)))
    mission = (await db.execute(text(
        "SELECT id, title, note, updated_at FROM tickets WHERE venture_id = :v AND run_id IS NULL"
        " AND role = 'owner' AND status = 'open' ORDER BY updated_at DESC LIMIT 1"), {"v": venture_id})).first()
    tickets = (await db.execute(text(
        f"SELECT {TICKET_COLS} FROM tickets t WHERE t.venture_id = :v AND NOT (t.run_id IS NULL AND t.role = 'owner')"
        " ORDER BY CASE t.status WHEN 'waiting_approval' THEN 0 WHEN 'blocked' THEN 1 WHEN 'open' THEN 2 ELSE 3 END,"
        " t.updated_at DESC LIMIT 80"), {"v": venture_id})).all()
    month = (await db.execute(text(
        "SELECT coalesce(sum(cost_usd), 0) AS cost, coalesce(sum(coalesce(prompt_tokens, 0) + coalesce(completion_tokens, 0)), 0) AS tokens"
        " FROM model_calls WHERE venture_id = :v AND status = 'ok'"
        " AND created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'"),
        {"v": venture_id})).first()
    usage = await org_usage(db, org, local)
    return BoardOut(
        mission=MissionOut(**mission._mapping) if mission else None,
        roles=roles,
        tickets=[TicketOut(**{**t._mapping, "cost_usd": _f(t.cost_usd)}) for t in tickets],
        month_cost_usd=_f(month.cost), month_tokens=int(month.tokens),
        budgets_editable=usage is None or usage.plan.autonomy)


class MissionIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    note: str = Field(default="", max_length=500)


@router.put("/ventures/{venture_id}/board/mission", response_model=MissionOut)
async def put_mission(venture_id: uuid.UUID, body: MissionIn, user_id: UserId, db: TenantDB) -> MissionOut:
    org = await venture_org(db, venture_id)
    await _require_admin(db, venture_id)
    try:
        async with db.begin_nested():
            await db.execute(text("UPDATE tickets SET status = 'done', finished_at = now(), updated_at = now()"
                                  " WHERE venture_id = :v AND run_id IS NULL AND role = 'owner' AND status = 'open'"),
                             {"v": venture_id})
            row = (await db.execute(text(
                "INSERT INTO tickets (org_id, venture_id, role, title, note, created_by)"
                " VALUES (:o, :v, 'owner', :t, :n, :u) RETURNING id, title, note, updated_at"),
                {"o": org, "v": venture_id, "t": body.title.strip(), "n": body.note.strip(), "u": user_id})).first()
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    return MissionOut(**row._mapping)


class AgentIn(BaseModel):
    role: Role | None = None
    monthly_tokens: int | None = Field(default=None, ge=0, le=100_000_000)
    clear_budget: bool = False


@router.put("/ventures/{venture_id}/board/agents/{workflow}", response_model=RoleOut)
async def put_agent(venture_id: uuid.UUID, workflow: str, body: AgentIn, user_id: UserId, db: TenantDB,
                    svc: Svc) -> RoleOut:
    """Move an agent to another role or set its monthly token budget (NULL = plan limit only)."""
    org = await venture_org(db, venture_id)
    await _require_admin(db, venture_id)
    if workflow not in registry:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown workflow")
    if body.monthly_tokens is not None or body.clear_budget:
        u = await org_usage(db, org, svc.router.local_deployments())
        if u is not None and not u.plan.autonomy:
            raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED,
                                f"per-agent budgets come with the Starter plan; {u.plan.label} has one shared allowance")
    sets = ["updated_by = :u", "updated_at = now()"]
    params: dict = {"o": org, "v": venture_id, "w": workflow, "u": user_id,
                    "role": body.role or DEFAULT_ROLE.get(workflow, "ops")}
    if body.role is not None:
        sets.append("role = :role")
    if body.clear_budget:
        sets.append("monthly_tokens = NULL")
    elif body.monthly_tokens is not None:
        sets.append("monthly_tokens = :mt")
        params["mt"] = body.monthly_tokens
    try:
        async with db.begin_nested():
            await db.execute(text(
                "INSERT INTO workflow_configs (org_id, venture_id, workflow, role, updated_by)"
                " VALUES (:o, :v, :w, :role, :u) ON CONFLICT (venture_id, workflow) DO UPDATE SET "
                + ", ".join(sets)), params)
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    svc.router.gate.forget_agent(venture_id, workflow)
    out = await board(venture_id, db, svc)
    for r in out.roles:
        if r.workflow == workflow:
            return r
    raise HTTPException(status.HTTP_404_NOT_FOUND, "agent not found")


class TicketIn(BaseModel):
    status: Literal["open", "done", "cancelled"] | None = None
    note: str | None = Field(default=None, max_length=500)


@router.patch("/ventures/{venture_id}/tickets/{ticket_id}", response_model=TicketOut)
async def patch_ticket(venture_id: uuid.UUID, ticket_id: uuid.UUID, body: TicketIn, db: TenantDB) -> TicketOut:
    """Owners can annotate any card and close or reopen cards that have no run; run cards follow the run."""
    await venture_org(db, venture_id)
    await _require_admin(db, venture_id)
    row = (await db.execute(text("SELECT run_id, status FROM tickets WHERE id = :t AND venture_id = :v"),
                            {"t": ticket_id, "v": venture_id})).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "ticket not found")
    if body.status is not None and row.run_id is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "this card follows its run; cancel or retry the run instead")
    await db.execute(text(
        "UPDATE tickets SET status = coalesce(:s, status), note = coalesce(:n, note), updated_at = now(),"
        " finished_at = CASE WHEN :s IN ('done', 'cancelled') THEN now() WHEN :s = 'open' THEN NULL ELSE finished_at END"
        " WHERE id = :t"), {"s": body.status, "n": body.note, "t": ticket_id})
    t = (await db.execute(text(f"SELECT {TICKET_COLS} FROM tickets t WHERE t.id = :t"), {"t": ticket_id})).first()
    return TicketOut(**{**t._mapping, "cost_usd": _f(t.cost_usd)})


async def _require_admin(db, venture_id: uuid.UUID) -> None:
    if not (await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "venture not found")
