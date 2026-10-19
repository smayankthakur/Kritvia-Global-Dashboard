"""The business's event stream and "tell me when" alerts (services/events.py).

  GET    /ventures/{v}/events?kind=&limit=       what happened, newest first
  GET    /ventures/{v}/events/kinds               what can happen, in words
  GET    /ventures/{v}/event-alerts               the alerts set up
  POST   /ventures/{v}/event-alerts               "tell me when …" (admins)
  DELETE /ventures/{v}/event-alerts/{id}
"""
from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from kritvia_api.deps import TenantDB, UserId, venture_org
from kritvia_api.services import events

router = APIRouter(tags=["events"])


class BusinessEventOut(BaseModel):
    id: int
    kind: str
    what: str = Field(description="the kind in words")
    summary: str
    amount_paise: int | None
    subject_table: str
    subject_id: uuid.UUID | None
    occurred_at: datetime


class EventKindOut(BaseModel):
    kind: str
    words: str
    has_amount: bool


class EventAlertIn(BaseModel):
    kind: str = Field(pattern=r"^[a-z_]+\.[a-z_]+$")
    min_paise: int | None = Field(default=None, gt=0, le=10_000_000_000_000)


class EventAlertOut(BaseModel):
    id: uuid.UUID
    kind: str
    words: str
    min_paise: int | None
    last_sent_at: datetime | None


@router.get("/ventures/{venture_id}/events", response_model=list[BusinessEventOut])
async def list_events(venture_id: uuid.UUID, db: TenantDB, kind: str | None = Query(default=None, max_length=40),
                      limit: int = Query(default=100, ge=1, le=500)) -> list[BusinessEventOut]:
    await venture_org(db, venture_id)
    got = await events.recent(db, venture_id, limit=limit, kind=kind)
    return [BusinessEventOut(**e, what=events.describe(e["kind"])) for e in got]


@router.get("/ventures/{venture_id}/events/kinds", response_model=list[EventKindOut])
async def kinds(venture_id: uuid.UUID, db: TenantDB) -> list[EventKindOut]:
    await venture_org(db, venture_id)
    return [EventKindOut(kind=k, words=w, has_amount=k in events.MONEY_KINDS) for k, w in events.KINDS.items()]


@router.get("/ventures/{venture_id}/event-alerts", response_model=list[EventAlertOut])
async def list_alerts(venture_id: uuid.UUID, db: TenantDB) -> list[EventAlertOut]:
    await venture_org(db, venture_id)
    rows = (await db.execute(text("SELECT id, kind, min_paise, last_sent_at FROM event_alerts WHERE venture_id = :v"
                                  " ORDER BY created_at"), {"v": venture_id})).all()
    return [EventAlertOut(id=r.id, kind=r.kind, words=events.describe(r.kind), min_paise=r.min_paise,
                     last_sent_at=r.last_sent_at) for r in rows]


async def _admin(db, venture_id: uuid.UUID) -> uuid.UUID:
    org = await venture_org(db, venture_id)
    if not (await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only the business's admins can set up alerts")
    return org


@router.post("/ventures/{venture_id}/event-alerts", response_model=EventAlertOut, status_code=201)
async def add_alert(venture_id: uuid.UUID, body: EventAlertIn, user_id: UserId, db: TenantDB) -> EventAlertOut:
    org = await _admin(db, venture_id)
    if body.kind not in events.KINDS:
        raise HTTPException(422, "choose one of the kinds of event")
    if body.min_paise and body.kind not in events.MONEY_KINDS:
        raise HTTPException(422, "an amount only applies to money events")
    if (await db.execute(text("SELECT count(*) FROM event_alerts WHERE venture_id = :v"), {"v": venture_id})).scalar() >= 30:
        raise HTTPException(status.HTTP_409_CONFLICT, "a business can have up to 30 alerts")
    try:
        async with db.begin_nested():
            r = (await db.execute(text(
                "INSERT INTO event_alerts (org_id, venture_id, kind, min_paise, created_by) VALUES (:o, :v, :k, :m, :u)"
                " RETURNING id, kind, min_paise, last_sent_at"),
                {"o": org, "v": venture_id, "k": body.kind, "m": body.min_paise, "u": user_id})).first()
    except IntegrityError:
        raise HTTPException(status.HTTP_409_CONFLICT, "that alert is already set up") from None
    return EventAlertOut(id=r.id, kind=r.kind, words=events.describe(r.kind), min_paise=r.min_paise,
                    last_sent_at=r.last_sent_at)


@router.delete("/ventures/{venture_id}/event-alerts/{alert_id}", status_code=204)
async def remove_alert(venture_id: uuid.UUID, alert_id: uuid.UUID, db: TenantDB) -> None:
    await _admin(db, venture_id)
    await db.execute(text("DELETE FROM event_alerts WHERE id = :a AND venture_id = :v"), {"a": alert_id, "v": venture_id})
