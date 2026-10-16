"""Bookings: what can be booked and when, the bookings themselves, and free times.

  GET/PUT /ventures/{v}/booking-settings        hours, slot length, notice, capacity (admins change them)
  GET/POST /ventures/{v}/booking-services       services; PATCH/DELETE /booking-services/{id}
  GET     /ventures/{v}/bookings                upcoming (or a date range)
  POST    /ventures/{v}/bookings                book by hand (a phone call, a walk-in)
  PATCH   /ventures/{v}/bookings/{id}           done, no-show, cancelled, notes
  GET     /ventures/{v}/booking-slots           free times for a service (opening hours and bookings)
"""
from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.deps import TenantDB, UserId, venture_org
from kritvia_api.errors import raise_for_db
from kritvia_api.services import bookings as svc

router = APIRouter(tags=["bookings"])


async def _admin(db, venture_id: uuid.UUID) -> uuid.UUID:
    org = await venture_org(db, venture_id)
    if not (await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only the business's admins can change how it takes bookings")
    return org


async def _writer(db, venture_id: uuid.UUID) -> uuid.UUID:
    org = await venture_org(db, venture_id)
    if not (await db.execute(text("SELECT :v = ANY (private.writable_ventures())"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "your role can see bookings but not change them")
    return org


class BookingSettings(BaseModel):
    enabled: bool = True
    hours: dict[str, list[list[str]]] = Field(default_factory=dict,
                                              description='{"mon": [["10:00","13:00"],["14:00","19:00"]], ...}')
    slot_minutes: Literal[10, 15, 20, 30, 45, 60, 90, 120] = 30
    notice_hours: int = Field(default=2, ge=0, le=168)
    days_ahead: int = Field(default=14, ge=1, le=90)
    capacity: int = Field(default=1, ge=1, le=50, description="bookings at the same time (chairs, rooms, staff)")
    use_calendar: bool = Field(default=True, description="skip times busy on Google Calendar and add bookings to it")

    @field_validator("hours")
    @classmethod
    def _h(cls, v: dict[str, Any]) -> dict[str, list[list[str]]]:
        return svc.clean_hours(v)


class BookingSettingsOut(BookingSettings):
    configured: bool
    can_edit: bool


@router.get("/ventures/{venture_id}/booking-settings", response_model=BookingSettingsOut)
async def get_settings_(venture_id: uuid.UUID, db: TenantDB) -> BookingSettingsOut:
    await venture_org(db, venture_id)
    r = (await db.execute(text("SELECT * FROM booking_settings WHERE venture_id = :v"), {"v": venture_id})).first()
    admin = bool((await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar())
    if r is None:
        return BookingSettingsOut(configured=False, can_edit=admin, enabled=False)
    return BookingSettingsOut(configured=True, can_edit=admin, enabled=r.enabled, hours=r.hours or {},
                              slot_minutes=r.slot_minutes, notice_hours=r.notice_hours, days_ahead=r.days_ahead,
                              capacity=r.capacity, use_calendar=r.use_calendar)


@router.put("/ventures/{venture_id}/booking-settings", response_model=BookingSettingsOut)
async def put_settings(venture_id: uuid.UUID, body: BookingSettings, db: TenantDB) -> BookingSettingsOut:
    import json
    org = await _admin(db, venture_id)
    await db.execute(text(
        "INSERT INTO booking_settings (venture_id, org_id, enabled, hours, slot_minutes, notice_hours, days_ahead,"
        " capacity, use_calendar) VALUES (:v, :o, :en, CAST(:h AS jsonb), :sm, :nh, :da, :c, :uc)"
        " ON CONFLICT (venture_id) DO UPDATE SET enabled = EXCLUDED.enabled, hours = EXCLUDED.hours,"
        " slot_minutes = EXCLUDED.slot_minutes, notice_hours = EXCLUDED.notice_hours, days_ahead = EXCLUDED.days_ahead,"
        " capacity = EXCLUDED.capacity, use_calendar = EXCLUDED.use_calendar, updated_at = now()"),
        {"v": venture_id, "o": org, "en": body.enabled, "h": json.dumps(body.hours), "sm": body.slot_minutes,
         "nh": body.notice_hours, "da": body.days_ahead, "c": body.capacity, "uc": body.use_calendar})
    return await get_settings_(venture_id, db)


class ServiceIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    minutes: int = Field(ge=5, le=600)
    price_paise: int | None = Field(default=None, ge=0, le=10_000_000_00)


class ServiceOut(ServiceIn):
    id: uuid.UUID
    active: bool


@router.get("/ventures/{venture_id}/booking-services", response_model=list[ServiceOut])
async def list_services(venture_id: uuid.UUID, db: TenantDB) -> list[ServiceOut]:
    await venture_org(db, venture_id)
    rows = (await db.execute(text("SELECT id, name, minutes, price_paise, active FROM booking_services"
                                  " WHERE venture_id = :v AND active ORDER BY name"), {"v": venture_id})).all()
    return [ServiceOut(**r._mapping) for r in rows]


def _dup(exc: DBAPIError) -> None:
    if "booking_services_name_uq" in str(exc):
        raise HTTPException(status.HTTP_409_CONFLICT, "there is already a service with this name") from None
    raise_for_db(exc, "venture not found")


@router.post("/ventures/{venture_id}/booking-services", response_model=ServiceOut, status_code=201)
async def add_service(venture_id: uuid.UUID, body: ServiceIn, db: TenantDB) -> ServiceOut:
    org = await _admin(db, venture_id)
    try:
        async with db.begin_nested():
            r = (await db.execute(text(
                "INSERT INTO booking_services (org_id, venture_id, name, minutes, price_paise) VALUES (:o, :v, :n, :m, :p)"
                " RETURNING id, name, minutes, price_paise, active"),
                {"o": org, "v": venture_id, "n": body.name.strip(), "m": body.minutes, "p": body.price_paise})).first()
    except DBAPIError as exc:
        _dup(exc)
    return ServiceOut(**r._mapping)


@router.patch("/ventures/{venture_id}/booking-services/{service_id}", response_model=ServiceOut)
async def edit_service(venture_id: uuid.UUID, service_id: uuid.UUID, body: ServiceIn, db: TenantDB) -> ServiceOut:
    await _admin(db, venture_id)
    try:
        async with db.begin_nested():
            r = (await db.execute(text(
                "UPDATE booking_services SET name = :n, minutes = :m, price_paise = :p WHERE id = :s AND venture_id = :v"
                " AND active RETURNING id, name, minutes, price_paise, active"),
                {"n": body.name.strip(), "m": body.minutes, "p": body.price_paise, "s": service_id,
                 "v": venture_id})).first()
    except DBAPIError as exc:
        _dup(exc)
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "service not found")
    return ServiceOut(**r._mapping)


@router.delete("/ventures/{venture_id}/booking-services/{service_id}", status_code=204)
async def remove_service(venture_id: uuid.UUID, service_id: uuid.UUID, db: TenantDB) -> None:
    """Stops offering it; bookings already made keep its name."""
    await _admin(db, venture_id)
    await db.execute(text("UPDATE booking_services SET active = false WHERE id = :s AND venture_id = :v"),
                     {"s": service_id, "v": venture_id})


class BookingOut(BaseModel):
    id: uuid.UUID
    service_name: str
    customer_name: str
    channel: str
    address: str | None
    starts_at: datetime
    ends_at: datetime
    status: str
    notes: str | None
    from_chat: bool
    in_calendar: bool
    reminded_at: datetime | None


def _booking(r) -> BookingOut:
    return BookingOut(id=r.id, service_name=r.service_name, customer_name=r.customer_name, channel=r.channel,
                      address=r.address, starts_at=r.starts_at, ends_at=r.ends_at, status=r.status, notes=r.notes,
                      from_chat=r.run_id is not None, in_calendar=r.calendar_event_id is not None,
                      reminded_at=r.reminded_at)


@router.get("/ventures/{venture_id}/bookings", response_model=list[BookingOut])
async def list_bookings(venture_id: uuid.UUID, db: TenantDB, start: date | None = None,
                        days: int = Query(default=14, ge=1, le=90),
                        show: Literal["upcoming", "all"] = "upcoming") -> list[BookingOut]:
    await venture_org(db, venture_id)
    since = datetime.combine(start, datetime.min.time(), UTC) if start else datetime.now(UTC) - timedelta(hours=2)
    rows = (await db.execute(text(
        "SELECT * FROM bookings WHERE venture_id = :v AND starts_at >= :s AND starts_at < :e"
        + (" AND status = 'confirmed'" if show == "upcoming" else "") + " ORDER BY starts_at LIMIT 500"),
        {"v": venture_id, "s": since, "e": since + timedelta(days=days)})).all()
    return [_booking(r) for r in rows]


class BookingIn(BaseModel):
    service_id: uuid.UUID
    starts_at: datetime
    customer_name: str = Field(min_length=1, max_length=160)
    phone: str | None = Field(default=None, max_length=24, description="for a WhatsApp reminder (customers who chat)")
    notes: str | None = Field(default=None, max_length=500)
    outside_hours: bool = Field(default=False, description="book even outside opening hours (still never overbooked)")


@router.post("/ventures/{venture_id}/bookings", response_model=BookingOut, status_code=201)
async def add_booking(venture_id: uuid.UUID, body: BookingIn, user_id: UserId, db: TenantDB) -> BookingOut:
    from kritvia_api.routers.invoices import phone_digits
    org = await _writer(db, venture_id)
    found = await svc.load(db, venture_id)
    if found is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "set up bookings first: opening hours and at least one service")
    s, services = found
    service = next((x for x in services if x.id == body.service_id), None)
    if service is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "service not found")
    if body.starts_at.tzinfo is None:
        raise HTTPException(422, "give the time with its time zone, e.g. 2026-10-18T11:00:00+05:30")
    try:
        phone = phone_digits(body.phone)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    try:
        async with db.begin_nested():
            bid = await svc.book(db, org_id=org, venture_id=venture_id, service=service, starts_at=body.starts_at,
                                 customer_name=body.customer_name.strip(), channel="whatsapp" if phone else "manual",
                                 address=phone, s=s, now=datetime.now(UTC) - timedelta(hours=s.notice_hours),
                                 created_by=user_id, notes=(body.notes or "").strip() or None,
                                 check_hours=not body.outside_hours)
    except svc.BookingProblem as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from None
    r = (await db.execute(text("SELECT * FROM bookings WHERE id = :b"), {"b": bid})).first()
    return _booking(r)


class BookingPatch(BaseModel):
    status: Literal["confirmed", "cancelled", "done", "no_show"] | None = None
    notes: str | None = Field(default=None, max_length=500)


@router.patch("/ventures/{venture_id}/bookings/{booking_id}", response_model=BookingOut)
async def edit_booking(venture_id: uuid.UUID, booking_id: uuid.UUID, body: BookingPatch, db: TenantDB) -> BookingOut:
    await _writer(db, venture_id)
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(422, "nothing to change")
    sets = ", ".join(f"{k} = :{k}" for k in fields)
    r = (await db.execute(text(f"UPDATE bookings SET {sets}, updated_at = now() WHERE id = :b AND venture_id = :v"
                               " RETURNING *"), {**fields, "b": booking_id, "v": venture_id})).first()
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "booking not found")
    return _booking(r)


class SlotsOut(BaseModel):
    service_id: uuid.UUID
    slots: list[datetime]


@router.get("/ventures/{venture_id}/booking-slots", response_model=SlotsOut)
async def slots(venture_id: uuid.UUID, service_id: uuid.UUID, db: TenantDB,
                days: int = Query(default=7, ge=1, le=90)) -> SlotsOut:
    """Free times from opening hours and bookings (Google Calendar is checked when a chat books)."""
    await venture_org(db, venture_id)
    found = await svc.load(db, venture_id)
    if found is None:
        return SlotsOut(service_id=service_id, slots=[])
    s, services = found
    service = next((x for x in services if x.id == service_id), None)
    if service is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "service not found")
    now = datetime.now(UTC)
    booked = await svc.taken(db, venture_id, now, now + timedelta(days=days + 1))
    return SlotsOut(service_id=service_id, slots=svc.free_slots(s, service.minutes, now, booked, [], days=days))
