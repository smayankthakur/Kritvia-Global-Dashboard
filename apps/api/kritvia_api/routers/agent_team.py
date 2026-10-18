"""The agent team and business templates (services/team.py, services/templates.py).

  GET   /ventures/{v}/team                         the four leads: goal, check-ins, budget, area, latest report
  PUT   /ventures/{v}/team/{role}                  set a lead's goal, check-in days and time, budget; switch it on/off
  POST  /ventures/{v}/team/{role}/check-in         check in now (as you)
  GET   /ventures/{v}/team/reports                 recent reports (optionally ?role=)
  GET   /templates                                 the industry starter kits
  POST  /ventures/{v}/templates/{key}/apply        add a kit to the business (admins)

Anyone who can see the business sees its team; admins set it up; operators can ask for a check-in.
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.errors import raise_for_db
from kritvia_api.ratelimit import limiter
from kritvia_api.services import skills as sk
from kritvia_api.services import team as tm
from kritvia_api.services import templates as tpl
from kritvia_api.services.crypto import EnvelopeCrypto
from kritvia_api.services.quota import PlanRestricted, org_usage

router = APIRouter(tags=["team"])
Role = Literal["front_desk", "sales", "accounts", "ops"]


class TeamLeadOut(BaseModel):
    role: Role
    title: str
    goal: str
    set_up: bool
    enabled: bool
    weekdays: list[int]
    at_time: str
    when: str
    monthly_tokens: int | None
    used_tokens: int
    agents: list[str]
    next_run_at: datetime | None
    last_run_at: datetime | None
    last_error: str | None
    latest_report: str | None
    latest_report_at: datetime | None


class AgentTeamOut(BaseModel):
    leads: list[TeamLeadOut]
    can_admin: bool
    can_check_in: bool


class TeamLeadIn(BaseModel):
    goal: str = Field(min_length=5, max_length=600)
    enabled: bool = True
    weekdays: list[int] = Field(default_factory=lambda: [0, 1, 2, 3, 4, 5], min_length=1, max_length=7)
    at_time: str = Field(default="09:30", pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")
    monthly_tokens: int | None = Field(default=None, ge=0, le=100_000_000)

    @field_validator("weekdays")
    @classmethod
    def _days(cls, v: list[int]) -> list[int]:
        days = sorted(set(v))
        if any(d < 0 or d > 6 for d in days):
            raise ValueError("weekdays are 0 (Monday) to 6 (Sunday)")
        return days


class TeamReportOut(BaseModel):
    id: uuid.UUID
    role: Role
    title: str
    body: str
    run_id: uuid.UUID | None
    created_at: datetime


class TeamRunOut(BaseModel):
    run_id: uuid.UUID


class TemplateKitOut(BaseModel):
    key: str
    name: str
    description: str
    kind: str
    agents: list[str]
    automations: list[str]
    skills: list[str]
    leads: list[str]


class TemplateAppliedOut(BaseModel):
    agents: list[str]
    automations: list[str]
    skills: list[str]
    leads: list[str]
    skipped: list[str]
    notes: list[str]


async def _can_admin(db, venture_id: uuid.UUID) -> bool:
    return bool((await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar())


async def _can_write(db, venture_id: uuid.UUID) -> bool:
    return bool((await db.execute(text("SELECT :v = ANY (private.writable_ventures())"), {"v": venture_id})).scalar())


async def _lead(db, crypto, svc, venture_id: uuid.UUID, role: str, rows, local: list[str]) -> TeamLeadOut:
    t = await tm.load(db, crypto, venture_id, role)
    base = t or {"role": role, "goal": tm.DEFAULT_GOALS[role], "enabled": False, "weekdays": [0, 1, 2, 3, 4, 5],
                 "at_time": "09:30", "monthly_tokens": None, "next_run_at": None, "last_run_at": None, "last_error": None}
    used = (await db.execute(text("SELECT role_usage(:v, :r, :l)"), {"v": venture_id, "r": role, "l": local})).scalar()
    rep = (await db.execute(text("SELECT body_enc, created_at FROM team_reports WHERE venture_id = :v AND role = :r"
                                 " ORDER BY created_at DESC LIMIT 1"), {"v": venture_id, "r": role})).first()
    body = await crypto.decrypt_str(venture_id, tm.REPORT, rep.body_enc) if rep else None
    return TeamLeadOut(role=role, title=tm.TITLES[role], goal=base["goal"], set_up=t is not None, enabled=base["enabled"],
                   weekdays=list(base["weekdays"]), at_time=base["at_time"], when=tm.describe(base),
                   monthly_tokens=base["monthly_tokens"], used_tokens=int(used or 0), agents=tm.area(rows, role),
                   next_run_at=base["next_run_at"] if base["enabled"] else None, last_run_at=base["last_run_at"],
                   last_error=base["last_error"], latest_report=body, latest_report_at=rep.created_at if rep else None)


@router.get("/ventures/{venture_id}/team", response_model=AgentTeamOut)
async def get_team(venture_id: uuid.UUID, db: TenantDB, svc: Svc) -> AgentTeamOut:
    await venture_org(db, venture_id)
    local = svc.router.local_deployments()
    rows = (await db.execute(text("SELECT * FROM board_roles(:v, :l)"), {"v": venture_id, "l": local})).all()
    crypto = EnvelopeCrypto(db, svc.keys)
    leads = [await _lead(db, crypto, svc, venture_id, r, rows, local) for r in tm.ROLES]
    return AgentTeamOut(leads=leads, can_admin=await _can_admin(db, venture_id), can_check_in=await _can_write(db, venture_id))


@router.put("/ventures/{venture_id}/team/{role}", response_model=TeamLeadOut)
async def put_lead(venture_id: uuid.UUID, role: Role, body: TeamLeadIn, user_id: UserId, db: TenantDB, svc: Svc) -> TeamLeadOut:
    org = await venture_org(db, venture_id)
    if not await _can_admin(db, venture_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only an admin sets up the team")
    local = svc.router.local_deployments()
    if body.monthly_tokens is not None:
        u = await org_usage(db, org, local)
        if u is not None and not u.plan.autonomy:
            raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED,
                                f"per-role budgets come with the Starter plan; {u.plan.label} has one shared allowance")
    crypto = EnvelopeCrypto(db, svc.keys)
    tz = await sk.tz_of(db, venture_id)
    nxt = tm.next_time(body.model_dump(), tz, datetime.now(UTC)) if body.enabled else None
    try:
        async with db.begin_nested():
            await db.execute(text(
                "INSERT INTO team_roles (org_id, venture_id, role, goal_enc, enabled, weekdays, at_time, monthly_tokens,"
                " next_run_at, created_by) VALUES (:o, :v, :r, :g, :e, :w, :at, :mt, :nx, :u)"
                " ON CONFLICT (venture_id, role) DO UPDATE SET goal_enc = EXCLUDED.goal_enc, enabled = EXCLUDED.enabled,"
                " weekdays = EXCLUDED.weekdays, at_time = EXCLUDED.at_time, monthly_tokens = EXCLUDED.monthly_tokens,"
                " next_run_at = EXCLUDED.next_run_at, last_error = NULL, updated_at = now()"),
                {"o": org, "v": venture_id, "r": role, "g": await crypto.encrypt(venture_id, tm.GOAL, body.goal.strip()),
                 "e": body.enabled, "w": body.weekdays, "at": body.at_time, "mt": body.monthly_tokens, "nx": nxt,
                 "u": user_id})
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    rows = (await db.execute(text("SELECT * FROM board_roles(:v, :l)"), {"v": venture_id, "l": local})).all()
    return await _lead(db, crypto, svc, venture_id, role, rows, local)


@router.post("/ventures/{venture_id}/team/{role}/check-in", response_model=TeamRunOut, status_code=201)
async def check_in_now(venture_id: uuid.UUID, role: Role, user_id: UserId, db: TenantDB, svc: Svc) -> TeamRunOut:
    await venture_org(db, venture_id)
    if not await _can_write(db, venture_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "asking a lead to check in needs an operator or admin role")
    await limiter.hit(f"team-check-in:{user_id}", per_minute=6)
    local = svc.router.local_deployments()
    t = await tm.load(db, EnvelopeCrypto(db, svc.keys), venture_id, role)
    if t is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "set this lead's goal first")
    if await tm.over_budget(db, venture_id, t, local):
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, "this role's monthly budget is used up")
    rows = (await db.execute(text("SELECT * FROM board_roles(:v, :l)"), {"v": venture_id, "l": local})).all()
    try:
        run_id = await tm.check_in(svc, venture_id, user_id, t, tm.area(rows, role), actor_type="user")
    except ValueError as exc:
        raise HTTPException(402 if isinstance(exc, PlanRestricted) else 422, str(exc)) from None
    return TeamRunOut(run_id=run_id)


@router.get("/ventures/{venture_id}/team/reports", response_model=list[TeamReportOut])
async def reports(venture_id: uuid.UUID, db: TenantDB, svc: Svc, role: Role | None = None) -> list[TeamReportOut]:
    await venture_org(db, venture_id)
    rows = (await db.execute(text(
        "SELECT id, role, run_id, body_enc, created_at FROM team_reports WHERE venture_id = :v"
        " AND (CAST(:r AS text) IS NULL OR role = :r) ORDER BY created_at DESC LIMIT 30"),
        {"v": venture_id, "r": role})).all()
    crypto = EnvelopeCrypto(db, svc.keys)
    return [TeamReportOut(id=r.id, role=r.role, title=tm.TITLES[r.role], run_id=r.run_id, created_at=r.created_at,
                      body=await crypto.decrypt_str(venture_id, tm.REPORT, r.body_enc) or "") for r in rows]


@router.get("/templates", response_model=list[TemplateKitOut])
async def list_templates() -> list[TemplateKitOut]:
    return [TemplateKitOut(**tpl.summary(k)) for k in tpl.KITS.values()]


@router.post("/ventures/{venture_id}/templates/{key}/apply", response_model=TemplateAppliedOut)
async def apply_template(venture_id: uuid.UUID, key: str, user_id: UserId, db: TenantDB, svc: Svc) -> TemplateAppliedOut:
    org = await venture_org(db, venture_id)
    if not await _can_admin(db, venture_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only an admin adds a template")
    k = tpl.KITS.get(key)
    if k is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such template")
    await limiter.hit(f"template-apply:{user_id}", per_minute=5)
    try:
        async with db.begin_nested():
            out = await tpl.apply(db, svc.keys, venture_id, org, user_id, k)
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    if out["agents"]:
        svc.router.gate.forget_agent(venture_id)
    return TemplateAppliedOut(**out)
