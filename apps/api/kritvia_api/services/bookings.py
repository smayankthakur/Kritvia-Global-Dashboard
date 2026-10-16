"""Bookings: free times from opening hours, existing bookings and Google Calendar, and making a booking
safely (the slot is checked again under a per-business lock, so two chats can't take the last one)."""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import text

DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
_HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


class BookingProblem(Exception):
    pass


@dataclass
class Settings:
    enabled: bool
    hours: dict[str, list[list[str]]]
    slot_minutes: int
    notice_hours: int
    days_ahead: int
    capacity: int
    use_calendar: bool
    tz: ZoneInfo


@dataclass
class Service:
    id: uuid.UUID
    name: str
    minutes: int
    price_paise: int | None


def clean_hours(hours: dict[str, Any]) -> dict[str, list[list[str]]]:
    """Validates {"mon": [["10:00","13:00"], ...], ...}: known days, HH:MM, opening before closing, no overlaps."""
    out: dict[str, list[list[str]]] = {}
    for day, spans in (hours or {}).items():
        if day not in DAYS:
            raise ValueError(f"unknown day {day!r} (use mon … sun)")
        if not isinstance(spans, list) or len(spans) > 4:
            raise ValueError("up to 4 opening spans a day")
        clean = []
        for span in spans:
            if not (isinstance(span, list | tuple) and len(span) == 2 and all(isinstance(x, str) and _HHMM.match(x) for x in span)):
                raise ValueError("opening hours are pairs like [\"10:00\", \"19:00\"]")
            if span[0] >= span[1]:
                raise ValueError(f"{day}: opening time must be before closing time")
            clean.append([span[0], span[1]])
        clean.sort()
        for a, b in zip(clean, clean[1:]):
            if b[0] < a[1]:
                raise ValueError(f"{day}: opening spans overlap")
        if clean:
            out[day] = clean
    return out


async def load(conn, venture_id: uuid.UUID) -> tuple[Settings, list[Service]] | None:
    s = (await conn.execute(text(
        "SELECT b.*, coalesce(v.timezone, 'Asia/Kolkata') AS tz FROM booking_settings b"
        " LEFT JOIN venture_settings v ON v.venture_id = b.venture_id WHERE b.venture_id = :v"), {"v": venture_id})).first()
    if s is None or not s.enabled:
        return None
    try:
        tz = ZoneInfo(s.tz)
    except Exception:  # noqa: BLE001
        tz = ZoneInfo("Asia/Kolkata")
    services = [Service(r.id, r.name, r.minutes, r.price_paise) for r in (await conn.execute(text(
        "SELECT id, name, minutes, price_paise FROM booking_services WHERE venture_id = :v AND active ORDER BY name"),
        {"v": venture_id})).all()]
    if not services:
        return None
    return Settings(True, s.hours or {}, s.slot_minutes, s.notice_hours, s.days_ahead, s.capacity, s.use_calendar, tz), services


async def taken(conn, venture_id: uuid.UUID, start: datetime, end: datetime) -> list[tuple[datetime, datetime]]:
    rows = (await conn.execute(text(
        "SELECT starts_at, ends_at FROM bookings WHERE venture_id = :v AND status = 'confirmed'"
        " AND starts_at < :e AND ends_at > :s"), {"v": venture_id, "s": start, "e": end})).all()
    return [(r.starts_at, r.ends_at) for r in rows]


def free_slots(s: Settings, minutes: int, now: datetime, booked: list[tuple[datetime, datetime]],
               busy: list[tuple[datetime, datetime]], *, limit: int = 200, days: int | None = None) -> list[datetime]:
    """Start times (aware, business time zone) where `minutes` fit inside opening hours, after the notice
    period, with fewer than `capacity` bookings overlapping and nothing on the calendar."""
    out: list[datetime] = []
    earliest = now + timedelta(hours=s.notice_hours)
    today = now.astimezone(s.tz).date()
    for d in range(min(days or s.days_ahead, s.days_ahead)):
        day: date = today + timedelta(days=d)
        for open_, close in s.hours.get(DAYS[day.weekday()], []):
            t = datetime.combine(day, time.fromisoformat(open_), s.tz)
            end_of_span = datetime.combine(day, time.fromisoformat(close), s.tz)
            while t + timedelta(minutes=minutes) <= end_of_span:
                e = t + timedelta(minutes=minutes)
                if t >= earliest and sum(1 for a, b in booked if a < e and b > t) < s.capacity \
                        and not any(a < e and b > t for a, b in busy):
                    out.append(t)
                    if len(out) >= limit:
                        return out
                t += timedelta(minutes=s.slot_minutes)
    return out


def spread(slots: list[datetime], n: int = 8) -> list[datetime]:
    """A few choices across the coming days rather than the next eight half-hours of today."""
    by_day: dict[date, list[datetime]] = {}
    for x in slots:
        by_day.setdefault(x.date(), []).append(x)
    picked: list[datetime] = []
    while len(picked) < n and any(by_day.values()):
        for day in sorted(by_day):
            if by_day[day] and len(picked) < n:
                lst = by_day[day]
                picked.append(lst.pop(0 if len(lst) % 2 else len(lst) // 2))
    return sorted(picked)


def label(t: datetime) -> str:
    return t.strftime("%a %d %b, %I:%M %p").replace(" 0", " ")


async def book(conn, *, org_id: uuid.UUID, venture_id: uuid.UUID, service: Service, starts_at: datetime,
               customer_name: str, channel: str, address: str | None, s: Settings, now: datetime,
               busy: list[tuple[datetime, datetime]] = (), run_id: uuid.UUID | None = None,
               created_by: uuid.UUID | None = None, notes: str | None = None, check_hours: bool = True) -> uuid.UUID:
    """Makes the booking if the slot is still free. Raises BookingProblem otherwise."""
    await conn.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": f"booking:{venture_id}"})
    end = starts_at + timedelta(minutes=service.minutes)
    if check_hours:
        ok = free_slots(s, service.minutes, now, await taken(conn, venture_id, starts_at, end), list(busy), limit=10_000)
        if starts_at not in ok:
            raise BookingProblem("that time is no longer free")
    elif len(await taken(conn, venture_id, starts_at, end)) >= s.capacity:
        raise BookingProblem("that time is already fully booked")
    return (await conn.execute(text(
        "INSERT INTO bookings (org_id, venture_id, service_id, service_name, customer_name, channel, address, starts_at,"
        " ends_at, run_id, created_by, notes) VALUES (:o, :v, :sid, :sn, :c, :ch, :a, :s, :e, :r, :u, :n) RETURNING id"),
        {"o": org_id, "v": venture_id, "sid": service.id, "sn": service.name, "c": customer_name[:160], "ch": channel,
         "a": (address or "")[:254] or None, "s": starts_at, "e": end, "r": run_id, "u": created_by,
         "n": notes})).scalar_one()


def parse_busy(events: list[dict[str, str]] | None, skip: set[str]) -> list[tuple[datetime, datetime]]:
    out = []
    for e in events or []:
        if e.get("id") in skip:
            continue
        try:
            out.append((datetime.fromisoformat(e["start"]), datetime.fromisoformat(e["end"])))
        except (KeyError, ValueError):
            continue
    return out
