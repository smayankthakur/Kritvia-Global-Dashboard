"""Autopilot: see what it covers on this plan, what it did today, and switch it on or off (services/autopilot.py).

  GET /ventures/{v}/autopilot     on/off, what it does by itself on this plan, today's numbers
  PUT /ventures/{v}/autopilot     {"on": true|false}   admins; audited (venture_settings has the audit trigger)
"""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import text

from kritvia_api.deps import TenantDB, UserId, venture_org
from kritvia_api.services import autopilot as ap
from kritvia_api.services.quota import plan_for_venture

router = APIRouter(tags=["autopilot"])


class AutopilotJob(BaseModel):
    agent: str
    what: str
    on_plan: bool = Field(description="this plan lets autopilot do it (else it keeps asking)")


class AutopilotOut(BaseModel):
    on: bool
    changed_at: datetime | None = None
    plan: str
    jobs: list[AutopilotJob]
    today_by_itself: dict[str, int]
    waiting: int
    held_today: int
    still_asks: list[str]


class AutopilotIn(BaseModel):
    on: bool


STILL_ASKS = ["Refunds, discounts and prices that aren't on your rate card", "Complaints and legal matters",
              "Orders, payments and anyone asking for a person", "Invoices, purchase orders, proposals and campaigns",
              "Payment reminders after the second one, and replies to 1-3 star reviews"]


@router.get("/ventures/{venture_id}/autopilot", response_model=AutopilotOut)
async def get_autopilot(venture_id: uuid.UUID, db: TenantDB) -> AutopilotOut:
    await venture_org(db, venture_id)
    row = (await db.execute(text("SELECT autopilot, autopilot_changed_at FROM venture_settings WHERE venture_id = :v"),
                            {"v": venture_id})).first()
    plan = await plan_for_venture(db, venture_id)
    jobs = [AutopilotJob(agent=a, what=ap.WORDS[a], on_plan=any(ap.plan_allows(plan, a, x) for x in acts))
            for a, acts in ap.ACTIONS.items()]
    day = await ap.today(db, venture_id, datetime.now(ap.IST).replace(hour=0, minute=0, second=0, microsecond=0))
    return AutopilotOut(on=bool(row and row.autopilot), changed_at=row.autopilot_changed_at if row else None,
                        plan=plan.name, jobs=jobs, today_by_itself=day.by_itself, waiting=day.waiting,
                        held_today=day.held, still_asks=STILL_ASKS)


@router.put("/ventures/{venture_id}/autopilot", response_model=AutopilotOut)
async def put_autopilot(venture_id: uuid.UUID, body: AutopilotIn, user_id: UserId, db: TenantDB) -> AutopilotOut:
    await venture_org(db, venture_id)
    if not (await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only an admin of this business can change autopilot")
    exists = (await db.execute(text("SELECT 1 FROM venture_settings WHERE venture_id = :v"), {"v": venture_id})).first()
    if exists is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "fill in the business profile first (Settings → General)")
    await ap.set_on(db, venture_id, body.on, user_id)
    return await get_autopilot(venture_id, db)
