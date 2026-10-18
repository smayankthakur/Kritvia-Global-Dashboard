"""Skills: jobs Kritvia learns, repeats and gets better at (services/skills.py).

  GET    /ventures/{v}/skills                       the business's skills, with their lessons
  POST   /ventures/{v}/skills/understand            plain words -> a draft to check (nothing saved)
  POST   /ventures/{v}/skills/from-request          one of your assistant requests -> a draft ("Save as a skill")
  POST   /ventures/{v}/skills                       save a skill
  PUT    /ventures/{v}/skills/{id}                  change it, or switch it off
  DELETE /ventures/{v}/skills/{id}
  POST   /ventures/{v}/skills/{id}/run              run it now (as you)
  DELETE /ventures/{v}/skills/{id}/lessons/{n}      forget one lesson
  GET    /ventures/{v}/skills/{id}/runs             its recent runs

Anyone who can see the business sees its skills; people who can change things there make and run them;
only the person who made a skill, or an admin, changes or removes it.
"""
from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.engine.runner import STATE_PURPOSE
from kritvia_api.errors import raise_for_db
from kritvia_api.ratelimit import limiter
from kritvia_api.services import skills as sk
from kritvia_api.services.crypto import EnvelopeCrypto
from kritvia_api.services.llm import LLMOutputError
from kritvia_api.services.model_router import CallContext
from kritvia_api.services.quota import PlanRestricted

router = APIRouter(tags=["skills"])


class SkillIn(sk.Draft):
    enabled: bool = True
    source_run_id: uuid.UUID | None = None


class SkillDraftOut(sk.Draft):
    when: str = Field(description="when it would run, in words")


class SkillOut(BaseModel):
    id: uuid.UUID
    name: str
    instructions: str
    lessons: list[str]
    lessons_learned: int
    trigger: Literal["manual", "schedule", "event"]
    freq: Literal["daily", "weekly", "monthly"] | None
    weekdays: list[int]
    day_of_month: int | None
    at_time: str | None
    event: Literal["invoice_overdue", "invoice_paid", "booking_done", "lead_new", "lead_quiet"] | None
    wait_days: int
    when: str
    enabled: bool
    next_run_at: datetime | None
    last_run_at: datetime | None
    last_error: str | None
    runs: int
    mine: bool
    can_edit: bool
    created_at: datetime


class WordsIn(BaseModel):
    words: str = Field(min_length=5, max_length=1500)


class FromRequestIn(BaseModel):
    run_id: uuid.UUID


class RunOut(BaseModel):
    run_id: uuid.UUID


class SkillRunOut(BaseModel):
    run_id: uuid.UUID
    status: str
    outcome: str | None
    created_at: datetime


async def _can_write(db, venture_id: uuid.UUID) -> bool:
    return bool((await db.execute(text("SELECT :v = ANY (private.writable_ventures())"), {"v": venture_id})).scalar())


async def _can_admin(db, venture_id: uuid.UUID) -> bool:
    return bool((await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar())


def _out(s: dict, user_id: uuid.UUID, admin: bool) -> SkillOut:
    return SkillOut(id=s["id"], name=s["name"], instructions=s["instructions"], lessons=s["lesson_list"],
                    lessons_learned=s["lessons"], trigger=s["trigger"], freq=s["freq"], weekdays=list(s["weekdays"] or []),
                    day_of_month=s["day_of_month"], at_time=s["at_time"], event=s["event"], wait_days=s["wait_days"],
                    when=sk.describe(s), enabled=s["enabled"], next_run_at=s["next_run_at"], last_run_at=s["last_run_at"],
                    last_error=s["last_error"], runs=s["runs"], mine=s["created_by"] == user_id,
                    can_edit=admin or s["created_by"] == user_id, created_at=s["created_at"])


async def _get(db, svc, venture_id: uuid.UUID, skill_id: uuid.UUID) -> dict:
    s = await sk.load(db, EnvelopeCrypto(db, svc.keys), venture_id, skill_id)
    if s is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "skill not found")
    return s


def _draft_out(d: sk.Draft) -> SkillDraftOut:
    return SkillDraftOut(**d.model_dump(), when=sk.describe(d.model_dump()))


@router.get("/ventures/{venture_id}/skills", response_model=list[SkillOut])
async def list_skills(venture_id: uuid.UUID, user_id: UserId, db: TenantDB, svc: Svc) -> list[SkillOut]:
    await venture_org(db, venture_id)
    ids = (await db.execute(text("SELECT id FROM skills WHERE venture_id = :v ORDER BY created_at"),
                            {"v": venture_id})).scalars().all()
    admin = await _can_admin(db, venture_id)
    crypto = EnvelopeCrypto(db, svc.keys)
    return [_out(s, user_id, admin) for i in ids if (s := await sk.load(db, crypto, venture_id, i))]


@router.post("/ventures/{venture_id}/skills/understand", response_model=SkillDraftOut)
async def understand(venture_id: uuid.UUID, body: WordsIn, user_id: UserId, db: TenantDB, svc: Svc) -> SkillDraftOut:
    org = await venture_org(db, venture_id)
    await limiter.hit(f"skill-understand:{user_id}", per_minute=10)
    try:
        d = await sk.understand(svc.router, CallContext(org_id=org, venture_id=venture_id, user_id=user_id, workflow="skill"),
                                body.words)
    except (LLMOutputError, ValueError) as exc:
        raise HTTPException(422, f"I couldn't turn that into a job: {str(exc)[:200]}. Try saying it step by step.") from None
    return _draft_out(d)


@router.post("/ventures/{venture_id}/skills/from-request", response_model=SkillDraftOut)
async def from_request(venture_id: uuid.UUID, body: FromRequestIn, user_id: UserId, db: TenantDB, svc: Svc) -> SkillDraftOut:
    """One of YOUR assistant requests (only yours) -> a draft skill that does the same job again."""
    org = await venture_org(db, venture_id)
    await limiter.hit(f"skill-understand:{user_id}", per_minute=10)
    r = (await db.execute(text("SELECT state_enc FROM workflow_runs WHERE id = :r AND venture_id = :v"
                               " AND workflow = 'assistant' AND started_by = :u"),
                          {"r": body.run_id, "v": venture_id, "u": user_id})).first()
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "request not found")
    state = json.loads(await EnvelopeCrypto(db, svc.keys).decrypt(venture_id, STATE_PURPOSE, r.state_enc))
    inp = state.get("input") or {}
    if inp.get("skill_id"):
        raise HTTPException(status.HTTP_409_CONFLICT, "this was already a skill's run")
    try:
        d = await sk.from_request(svc.router, CallContext(org_id=org, venture_id=venture_id, user_id=user_id, workflow="skill"),
                                  str(inp.get("request") or ""), state.get("log") or [])
    except (LLMOutputError, ValueError) as exc:
        raise HTTPException(422, f"I couldn't turn that request into a job: {str(exc)[:200]}") from None
    return _draft_out(d)


async def _write(db, svc, venture_id: uuid.UUID, body: SkillIn, *, skill_id: uuid.UUID | None, user_id: uuid.UUID,
                 org: uuid.UUID) -> uuid.UUID:
    try:
        d = sk.clean(sk.Draft(**body.model_dump(exclude={"enabled", "source_run_id"})))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    tz = await sk.tz_of(db, venture_id)
    nxt = sk.next_time(d.model_dump(), tz, datetime.now(UTC)) if body.enabled else None
    enc = await EnvelopeCrypto(db, svc.keys).encrypt(venture_id, sk.INSTRUCTIONS, d.instructions)
    p = {"o": org, "v": venture_id, "u": user_id, "n": d.name, "i": enc, "t": d.trigger, "f": d.freq, "w": d.weekdays,
         "dm": d.day_of_month, "at": d.at_time, "ev": d.event, "wd": d.wait_days, "en": body.enabled, "nx": nxt,
         "src": body.source_run_id, "id": skill_id}
    try:
        async with db.begin_nested():
            if skill_id is None:
                return (await db.execute(text(
                    "INSERT INTO skills (org_id, venture_id, created_by, name, instructions_enc, trigger, freq, weekdays,"
                    " day_of_month, at_time, event, wait_days, enabled, next_run_at, source_run_id)"
                    " VALUES (:o, :v, :u, :n, :i, :t, :f, :w, :dm, :at, :ev, :wd, :en, :nx, :src) RETURNING id"), p)).scalar_one()
            await db.execute(text(
                "UPDATE skills SET name = :n, instructions_enc = :i, trigger = :t, freq = :f, weekdays = :w,"
                " day_of_month = :dm, at_time = :at, event = :ev, wait_days = :wd, enabled = :en, next_run_at = :nx,"
                " last_error = NULL, updated_at = now() WHERE id = :id AND venture_id = :v"), p)
            return skill_id
    except DBAPIError as exc:
        if "skills_name_idx" in str(exc):
            raise HTTPException(status.HTTP_409_CONFLICT, "a skill with this name already exists") from None
        raise_for_db(exc, "venture not found")
    raise AssertionError


@router.post("/ventures/{venture_id}/skills", response_model=SkillOut, status_code=201)
async def create_skill(venture_id: uuid.UUID, body: SkillIn, user_id: UserId, db: TenantDB, svc: Svc) -> SkillOut:
    org = await venture_org(db, venture_id)
    if not await _can_write(db, venture_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "making skills needs an operator or admin role")
    n = (await db.execute(text("SELECT count(*) FROM skills WHERE venture_id = :v"), {"v": venture_id})).scalar()
    if n >= sk.MAX_SKILLS:
        raise HTTPException(status.HTTP_409_CONFLICT, f"a business can have up to {sk.MAX_SKILLS} skills")
    sid = await _write(db, svc, venture_id, body, skill_id=None, user_id=user_id, org=org)
    return _out(await _get(db, svc, venture_id, sid), user_id, await _can_admin(db, venture_id))


async def _editable(db, svc, venture_id: uuid.UUID, skill_id: uuid.UUID, user_id: uuid.UUID) -> dict:
    s = await _get(db, svc, venture_id, skill_id)
    if s["created_by"] != user_id and not await _can_admin(db, venture_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only the person who made this skill, or an admin, can change it")
    return s


@router.put("/ventures/{venture_id}/skills/{skill_id}", response_model=SkillOut)
async def update_skill(venture_id: uuid.UUID, skill_id: uuid.UUID, body: SkillIn, user_id: UserId, db: TenantDB,
                       svc: Svc) -> SkillOut:
    org = await venture_org(db, venture_id)
    await _editable(db, svc, venture_id, skill_id, user_id)
    await _write(db, svc, venture_id, body, skill_id=skill_id, user_id=user_id, org=org)
    return _out(await _get(db, svc, venture_id, skill_id), user_id, await _can_admin(db, venture_id))


@router.delete("/ventures/{venture_id}/skills/{skill_id}", status_code=204)
async def delete_skill(venture_id: uuid.UUID, skill_id: uuid.UUID, user_id: UserId, db: TenantDB, svc: Svc) -> None:
    await venture_org(db, venture_id)
    await _editable(db, svc, venture_id, skill_id, user_id)
    await db.execute(text("DELETE FROM skills WHERE id = :s AND venture_id = :v"), {"s": skill_id, "v": venture_id})


@router.delete("/ventures/{venture_id}/skills/{skill_id}/lessons/{index}", response_model=SkillOut)
async def forget_lesson(venture_id: uuid.UUID, skill_id: uuid.UUID, index: int, user_id: UserId, db: TenantDB,
                        svc: Svc) -> SkillOut:
    await venture_org(db, venture_id)
    s = await _editable(db, svc, venture_id, skill_id, user_id)
    items = s["lesson_list"]
    if not 0 <= index < len(items):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "lesson not found")
    items = items[:index] + items[index + 1:]
    enc = await EnvelopeCrypto(db, svc.keys).encrypt(venture_id, sk.LESSONS, json.dumps(items, ensure_ascii=False))
    await db.execute(text("UPDATE skills SET lessons_enc = :l, updated_at = now() WHERE id = :s"), {"l": enc, "s": skill_id})
    return _out(await _get(db, svc, venture_id, skill_id), user_id, await _can_admin(db, venture_id))


@router.post("/ventures/{venture_id}/skills/{skill_id}/run", response_model=RunOut, status_code=201)
async def run_skill(venture_id: uuid.UUID, skill_id: uuid.UUID, user_id: UserId, db: TenantDB, svc: Svc) -> RunOut:
    await venture_org(db, venture_id)
    if not await _can_write(db, venture_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "running skills needs an operator or admin role")
    await limiter.hit(f"skill-run:{user_id}", per_minute=10)
    s = await _get(db, svc, venture_id, skill_id)
    try:
        run_id = await sk.start(svc, s, actor_user_id=user_id, actor_type="user", trigger_kind="manual")
    except ValueError as exc:
        raise HTTPException(402 if isinstance(exc, PlanRestricted) else 422, str(exc)) from None
    return RunOut(run_id=run_id)


@router.get("/ventures/{venture_id}/skills/{skill_id}/runs", response_model=list[SkillRunOut])
async def skill_runs(venture_id: uuid.UUID, skill_id: uuid.UUID, db: TenantDB, svc: Svc) -> list[SkillRunOut]:
    await venture_org(db, venture_id)
    await _get(db, svc, venture_id, skill_id)
    rows = (await db.execute(text(
        "SELECT id, status, outcome, created_at FROM workflow_runs WHERE venture_id = :v AND workflow = 'assistant'"
        " AND trigger_ref = :ref ORDER BY created_at DESC LIMIT 20"), {"v": venture_id, "ref": f"skill:{skill_id}"})).all()
    return [SkillRunOut(run_id=r.id, status=r.status, outcome=r.outcome, created_at=r.created_at) for r in rows]
