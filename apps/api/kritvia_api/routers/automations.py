"""Automations from plain words.

  POST   /ventures/{v}/automations/understand   "every Monday send me last week's sales" -> a draft to confirm
  POST   /ventures/{v}/automations              save it (computes the next run)
  GET    /ventures/{v}/automations              the business's automations
  PATCH  /ventures/{v}/automations/{id}         switch on or off
  DELETE /ventures/{v}/automations/{id}
  POST   /ventures/{v}/automations/{id}/run     run it now
  GET    /ventures/{v}/automations/{id}/results the latest results
"""
from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text

from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.engine.runner import DuplicateTrigger, start_run
from kritvia_api.ratelimit import limiter
from kritvia_api.services import automations as au
from kritvia_api.services.crypto import EnvelopeCrypto
from kritvia_api.services.llm import LLMOutputError, complete_json
from kritvia_api.services.model_router import CallContext
from kritvia_api.workflows.automation import RESULT_PURPOSE

router = APIRouter(tags=["automations"])
Period = Literal["today", "yesterday", "last_7_days", "last_week", "this_month", "last_month", "last_30_days",
                 "tomorrow", "next_7_days"]
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class AutomationDraft(BaseModel):
    name: str = Field(min_length=1, max_length=80, description="a short name, e.g. 'Weekly sales'")
    task: str = Field(min_length=3, max_length=500, description="what to produce, as an instruction")
    period: Period = Field(description="the time the report covers")
    freq: Literal["daily", "weekly", "monthly"]
    weekdays: list[int] = Field(default_factory=list, description="0=Monday … 6=Sunday, for weekly")
    day_of_month: int | None = Field(default=None, ge=1, le=28, description="for monthly")
    at_time: str = Field(default="09:00", pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")
    channel: Literal["email", "telegram", "slack", "app"] = "email"
    recipients: list[str] = Field(default_factory=list, max_length=10,
                                  description="other people's email addresses; empty when it's for the person asking")

    @field_validator("weekdays")
    @classmethod
    def _wd(cls, v: list[int]) -> list[int]:
        if any(d not in range(7) for d in v):
            raise ValueError("weekdays are 0 (Monday) to 6 (Sunday)")
        return sorted(set(v))

    @field_validator("recipients")
    @classmethod
    def _rcpt(cls, v: list[str]) -> list[str]:
        out = [x.strip().lower() for x in v if x.strip()]
        bad = [x for x in out if not EMAIL.match(x)]
        if bad:
            raise ValueError(f"not an email address: {bad[0]}")
        return out


class UnderstandIn(BaseModel):
    text: str = Field(min_length=3, max_length=500)


class UnderstandOut(AutomationDraft):
    when: str = Field(description="the schedule in words")
    said: str


def _check(d: AutomationDraft) -> None:
    if d.freq == "weekly" and not d.weekdays:
        raise HTTPException(422, "say which day(s) of the week")
    if d.freq == "monthly" and not d.day_of_month:
        raise HTTPException(422, "say which date of the month (1 to 28)")


@router.post("/ventures/{venture_id}/automations/understand", response_model=UnderstandOut)
async def understand(venture_id: uuid.UUID, body: UnderstandIn, user_id: UserId, db: TenantDB, svc: Svc) -> UnderstandOut:
    org = await venture_org(db, venture_id)
    await limiter.hit(f"automation-understand:{user_id}", per_minute=10)
    try:
        d = await complete_json(
            svc.router, CallContext(org_id=org, venture_id=venture_id, user_id=user_id, workflow="automation"),
            tier="extract", schema=AutomationDraft,
            system=("You turn a business owner's request (English, Hindi or Hinglish) into a schedule and a report task. "
                    "Kritvia can report on: money received, invoices issued, money still to collect, overdue "
                    "invoices and invoices falling due, bookings (with the list of appointments), new leads, drafts by "
                    "its agents and drafts waiting for a yes. 'Sales' means money received and "
                    "invoices issued. Pick the period the request implies (e.g. 'last week's' -> last_week, "
                    "'yesterday's' -> yesterday, 'this month' -> this_month, 'tomorrow's appointments' -> tomorrow, "
                    "'dues this week' -> next_7_days); default last_7_days for weekly, yesterday "
                    "for daily, last_month for monthly. Times are 24-hour HH:MM in India time; default 09:00. "
                    "channel: email unless they say Telegram, Slack or 'in the app'. recipients: only email addresses "
                    "written in the request for OTHER people; 'me' means none."),
            prompt=f"Request: {body.text.strip()}")
    except LLMOutputError:
        raise HTTPException(422, "Kritvia couldn't turn that into a schedule; try e.g. 'every Monday at 9 send me "
                                 "last week's sales'") from None
    _check(d)
    return UnderstandOut(**d.model_dump(), when=au.describe(d.freq, d.weekdays, d.day_of_month, d.at_time),
                         said=body.text.strip())


class AutomationIn(AutomationDraft):
    said: str = Field(min_length=3, max_length=500)


class AutomationOut(AutomationIn):
    id: uuid.UUID
    when: str
    enabled: bool
    next_run_at: datetime | None
    last_run_at: datetime | None
    last_error: str | None
    mine: bool
    owner: str


async def _tz(db, venture_id: uuid.UUID) -> ZoneInfo:
    tz = (await db.execute(text("SELECT timezone FROM venture_settings WHERE venture_id = :v"), {"v": venture_id})).scalar()
    try:
        return ZoneInfo(tz or "Asia/Kolkata")
    except Exception:  # noqa: BLE001
        return ZoneInfo("Asia/Kolkata")


def _out(r, user_id: uuid.UUID) -> AutomationOut:
    return AutomationOut(id=r.id, name=r.name, task=r.task, period=r.period, freq=r.freq, weekdays=list(r.weekdays),
                         day_of_month=r.day_of_month, at_time=r.at_time, channel=r.channel,
                         recipients=list(r.recipients), said=r.said, enabled=r.enabled, next_run_at=r.next_run_at,
                         last_run_at=r.last_run_at, last_error=r.last_error, mine=r.created_by == user_id,
                         owner=r.owner, when=au.describe(r.freq, list(r.weekdays), r.day_of_month, r.at_time))


SELECT = ("SELECT a.*, coalesce(nullif(o.full_name, ''), o.email, 'a team member') AS owner FROM automations a"
          " LEFT JOIN LATERAL private.automation_owner(a.id) o ON true")


@router.post("/ventures/{venture_id}/automations", response_model=AutomationOut, status_code=201)
async def create(venture_id: uuid.UUID, body: AutomationIn, user_id: UserId, db: TenantDB) -> AutomationOut:
    org = await venture_org(db, venture_id)
    if not (await db.execute(text("SELECT :v = ANY (private.writable_ventures())"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "your role can't create automations")
    _check(body)
    if (await db.execute(text("SELECT count(*) FROM automations WHERE venture_id = :v"), {"v": venture_id})).scalar() >= 25:
        raise HTTPException(status.HTTP_409_CONFLICT, "a business can have up to 25 automations")
    nxt = au.next_run(body.freq, body.weekdays, body.day_of_month, body.at_time, await _tz(db, venture_id), datetime.now(UTC))
    rid = (await db.execute(text(
        "INSERT INTO automations (org_id, venture_id, created_by, name, said, task, period, freq, weekdays, day_of_month,"
        " at_time, channel, recipients, next_run_at) VALUES (:o, :v, :u, :n, :s, :t, :p, :f, :w, :d, :at, :c, :r, :nx)"
        " RETURNING id"),
        {"o": org, "v": venture_id, "u": user_id, "n": body.name.strip(), "s": body.said.strip(), "t": body.task.strip(),
         "p": body.period, "f": body.freq, "w": body.weekdays if body.freq == "weekly" else [],
         "d": body.day_of_month if body.freq == "monthly" else None, "at": body.at_time, "c": body.channel,
         "r": body.recipients, "nx": nxt})).scalar_one()
    return _out((await db.execute(text(SELECT + " WHERE a.id = :a"), {"a": rid})).first(), user_id)


@router.get("/ventures/{venture_id}/automations", response_model=list[AutomationOut])
async def list_(venture_id: uuid.UUID, user_id: UserId, db: TenantDB) -> list[AutomationOut]:
    await venture_org(db, venture_id)
    rows = (await db.execute(text(SELECT + " WHERE a.venture_id = :v ORDER BY a.created_at"), {"v": venture_id})).all()
    return [_out(r, user_id) for r in rows]


async def _mine(db, venture_id: uuid.UUID, automation_id: uuid.UUID, user_id: uuid.UUID):
    r = (await db.execute(text(SELECT + " WHERE a.id = :a AND a.venture_id = :v"), {"a": automation_id, "v": venture_id})).first()
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "automation not found")
    admin = (await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar()
    if r.created_by != user_id and not admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only the person who made it (or an admin) can change it")
    return r


class AutomationPatch(BaseModel):
    enabled: bool


@router.patch("/ventures/{venture_id}/automations/{automation_id}", response_model=AutomationOut)
async def patch(venture_id: uuid.UUID, automation_id: uuid.UUID, body: AutomationPatch, user_id: UserId,
                db: TenantDB) -> AutomationOut:
    r = await _mine(db, venture_id, automation_id, user_id)
    nxt = au.next_run(r.freq, list(r.weekdays), r.day_of_month, r.at_time, await _tz(db, venture_id),
                      datetime.now(UTC)) if body.enabled else None
    await db.execute(text("UPDATE automations SET enabled = :e, next_run_at = :n, last_error = NULL WHERE id = :a"),
                     {"e": body.enabled, "n": nxt, "a": automation_id})
    return _out((await db.execute(text(SELECT + " WHERE a.id = :a"), {"a": automation_id})).first(), user_id)


@router.delete("/ventures/{venture_id}/automations/{automation_id}", status_code=204)
async def delete(venture_id: uuid.UUID, automation_id: uuid.UUID, user_id: UserId, db: TenantDB) -> None:
    await _mine(db, venture_id, automation_id, user_id)
    await db.execute(text("DELETE FROM automations WHERE id = :a"), {"a": automation_id})


class RunOut(BaseModel):
    run_id: uuid.UUID


@router.post("/ventures/{venture_id}/automations/{automation_id}/run", response_model=RunOut, status_code=201)
async def run_now(venture_id: uuid.UUID, automation_id: uuid.UUID, user_id: UserId, db: TenantDB, svc: Svc) -> RunOut:
    r = await _mine(db, venture_id, automation_id, user_id)
    await limiter.hit(f"automation-run:{automation_id}", per_minute=2)
    try:
        run_id = await start_run(svc, actor_user_id=user_id, venture_id=venture_id, workflow="automation",
                                 input={"automation_id": str(automation_id)}, title=f"Automation: {r.name}"[:120],
                                 dedupe=("automation-now", f"{automation_id}:{datetime.now(UTC):%Y%m%d%H%M%S}"))
    except DuplicateTrigger:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "it's already running") from None
    return RunOut(run_id=run_id)


class ResultOut(BaseModel):
    id: uuid.UUID
    text: str
    delivered: str | None
    created_at: datetime


@router.get("/ventures/{venture_id}/automations/{automation_id}/results", response_model=list[ResultOut])
async def results(venture_id: uuid.UUID, automation_id: uuid.UUID, db: TenantDB, svc: Svc) -> list[ResultOut]:
    await venture_org(db, venture_id)
    rows = (await db.execute(text(
        "SELECT id, body_enc, delivered, created_at FROM automation_results WHERE automation_id = :a AND venture_id = :v"
        " ORDER BY created_at DESC LIMIT 10"), {"a": automation_id, "v": venture_id})).all()
    crypto = EnvelopeCrypto(db, svc.keys)
    return [ResultOut(id=r.id, text=await crypto.decrypt_str(venture_id, RESULT_PURPOSE, r.body_enc) or "",
                      delivered=r.delivered, created_at=r.created_at) for r in rows]
