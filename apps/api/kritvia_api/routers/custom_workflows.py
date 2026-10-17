"""Custom workflows (Scale and Enterprise): a business's own agents.

  GET    /ventures/{v}/custom-workflows              the business's custom workflows (and whether the plan has them)
  POST   /ventures/{v}/custom-workflows              make one
  PATCH  /ventures/{v}/custom-workflows/{id}         change it, or switch it on/off
  DELETE /ventures/{v}/custom-workflows/{id}
  POST   /ventures/{v}/custom-workflows/{id}/run     check for matching records now
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import text

from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.engine.runner import DuplicateTrigger, start_run
from kritvia_api.plans import plan as plan_of
from kritvia_api.services import custom_workflows as cw
from kritvia_api.services.quota import plan_for_venture

router = APIRouter(tags=["custom workflows"])
Trigger = Literal["invoice_overdue", "invoice_paid", "booking_done", "lead_new", "lead_quiet"]
TIME = r"^([01][0-9]|2[0-3]):[0-5][0-9]$"


class CustomIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    trigger: Trigger
    wait_days: int = Field(default=0, ge=0, le=90)
    instructions: str = Field(min_length=3, max_length=2000, description="what to write, in plain words")
    action: Literal["email", "notify"] = "email"
    at_time: str = Field(default="10:00", pattern=TIME)


class CustomPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    enabled: bool | None = None
    wait_days: int | None = Field(default=None, ge=0, le=90)
    instructions: str | None = Field(default=None, min_length=3, max_length=2000)
    action: Literal["email", "notify"] | None = None
    at_time: str | None = Field(default=None, pattern=TIME)


class CustomOut(CustomIn):
    id: uuid.UUID
    enabled: bool
    when: str
    next_run_at: datetime | None
    last_run_at: datetime | None
    last_error: str | None


class CustomListOut(BaseModel):
    available: bool = Field(description="the plan includes custom workflows")
    items: list[CustomOut]


def _out(r) -> CustomOut:
    return CustomOut(id=r.id, name=r.name, trigger=r.trigger, wait_days=r.wait_days, instructions=r.instructions,
                     action=r.action, at_time=r.at_time, enabled=r.enabled, when=cw.describe(r.trigger, r.wait_days),
                     next_run_at=r.next_run_at, last_run_at=r.last_run_at, last_error=r.last_error)


async def _available(db, venture_id: uuid.UUID) -> bool:
    return "custom_workflows" in plan_of((await plan_for_venture(db, venture_id)).code).extras


async def _writer(db, venture_id: uuid.UUID) -> None:
    if not (await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only the business's admins can change custom workflows")


@router.get("/ventures/{venture_id}/custom-workflows", response_model=CustomListOut)
async def list_custom(venture_id: uuid.UUID, db: TenantDB) -> CustomListOut:
    await venture_org(db, venture_id)
    rows = (await db.execute(text("SELECT * FROM custom_workflows WHERE venture_id = :v ORDER BY created_at"),
                             {"v": venture_id})).all()
    return CustomListOut(available=await _available(db, venture_id), items=[_out(r) for r in rows])


@router.post("/ventures/{venture_id}/custom-workflows", response_model=CustomOut, status_code=201)
async def create_custom(venture_id: uuid.UUID, body: CustomIn, user_id: UserId, db: TenantDB) -> CustomOut:
    org = await venture_org(db, venture_id)
    await _writer(db, venture_id)
    if not await _available(db, venture_id):
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, "custom workflows are part of the Scale and Enterprise plans")
    if (await db.execute(text("SELECT count(*) FROM custom_workflows WHERE venture_id = :v"), {"v": venture_id})).scalar() >= 25:
        raise HTTPException(status.HTTP_409_CONFLICT, "a business can have up to 25 custom workflows")
    r = (await db.execute(text(
        "INSERT INTO custom_workflows (org_id, venture_id, created_by, name, trigger, wait_days, instructions, action,"
        " at_time, next_run_at) VALUES (:o, :v, :u, :n, :t, :w, :i, :a, :at, :nx) RETURNING *"),
        {"o": org, "v": venture_id, "u": user_id, "n": body.name.strip(), "t": body.trigger, "w": body.wait_days,
         "i": body.instructions.strip(), "a": body.action, "at": body.at_time, "nx": cw.next_run(body.at_time)})).first()
    return _out(r)


@router.patch("/ventures/{venture_id}/custom-workflows/{custom_id}", response_model=CustomOut)
async def update_custom(venture_id: uuid.UUID, custom_id: uuid.UUID, body: CustomPatch, db: TenantDB) -> CustomOut:
    await venture_org(db, venture_id)
    await _writer(db, venture_id)
    fields = body.model_dump(exclude_none=True)
    if fields.get("enabled") and not await _available(db, venture_id):
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, "custom workflows are part of the Scale and Enterprise plans")
    sets = [f"{k} = :{k}" for k in fields]
    if "at_time" in fields or fields.get("enabled"):
        cur = (await db.execute(text("SELECT at_time FROM custom_workflows WHERE id = :c AND venture_id = :v"),
                                {"c": custom_id, "v": venture_id})).scalar()
        if cur is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "no such custom workflow")
        fields["next_run_at"] = cw.next_run(fields.get("at_time", cur))
        sets.append("next_run_at = :next_run_at")
    if not sets:
        raise HTTPException(422, "nothing to change")
    r = (await db.execute(text(f"UPDATE custom_workflows SET {', '.join(sets)}, updated_at = now()"
                               " WHERE id = :c AND venture_id = :v RETURNING *"),
                          {**fields, "c": custom_id, "v": venture_id})).first()
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such custom workflow")
    return _out(r)


@router.delete("/ventures/{venture_id}/custom-workflows/{custom_id}", status_code=204)
async def delete_custom(venture_id: uuid.UUID, custom_id: uuid.UUID, db: TenantDB) -> None:
    await venture_org(db, venture_id)
    await _writer(db, venture_id)
    if (await db.execute(text("DELETE FROM custom_workflows WHERE id = :c AND venture_id = :v RETURNING id"),
                         {"c": custom_id, "v": venture_id})).first() is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such custom workflow")


class RunOut(BaseModel):
    run_id: uuid.UUID


@router.post("/ventures/{venture_id}/custom-workflows/{custom_id}/run", response_model=RunOut, status_code=201)
async def run_custom(venture_id: uuid.UUID, custom_id: uuid.UUID, user_id: UserId, db: TenantDB, svc: Svc) -> RunOut:
    await venture_org(db, venture_id)
    await _writer(db, venture_id)
    if not await _available(db, venture_id):
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, "custom workflows are part of the Scale and Enterprise plans")
    c = (await db.execute(text("SELECT id, name FROM custom_workflows WHERE id = :c AND venture_id = :v"),
                          {"c": custom_id, "v": venture_id})).first()
    if c is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such custom workflow")
    try:
        rid = await start_run(svc, actor_user_id=user_id, actor_type="user", venture_id=venture_id, workflow="custom",
                              input={"custom_id": str(c.id), "mode": "scan"}, trigger_kind="manual",
                              dedupe=("custom-scan", f"{c.id}:{datetime.now(UTC):%Y%m%d%H%M}"),
                              title=f"Custom workflow: {c.name}"[:120])
    except DuplicateTrigger:
        raise HTTPException(status.HTTP_409_CONFLICT, "it already ran this minute") from None
    return RunOut(run_id=rid)
