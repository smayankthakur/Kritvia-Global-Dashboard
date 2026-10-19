"""The business's Google Business Profile, through its own Google connection (scope business.manage):
review replies and 'What's new' updates are posted to Google after a yes.

Google must approve the Google Cloud project for the Business Profile APIs once (Google's access request);
until then every call answers 403 and Kritvia falls back to drafts a person copies into Google.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import text

from kritvia_api.services.crypto import EnvelopeCrypto
from kritvia_api.services.google import SCOPES


@dataclass
class Profile:
    token: str
    location: str | None          # accounts/N/locations/M, when the business chose its listing
    title: str | None


class NotConnected(Exception):
    """Google isn't connected with Business Profile access (the message says what to do)."""


async def connection(conn, venture_id: uuid.UUID):
    return (await conn.execute(text(
        "SELECT c.id, c.scopes, t.secret_enc FROM connectors c JOIN connector_tokens t ON t.connector_id = c.id"
        " WHERE c.venture_id = :v AND c.provider = 'google' AND c.status = 'active'"), {"v": venture_id})).first()


async def has_access(conn, venture_id: uuid.UUID) -> bool:
    c = await connection(conn, venture_id)
    return bool(c and SCOPES["business.manage"] in (c.scopes or []))


async def profile(services, conn, venture_id: uuid.UUID) -> Profile:
    google = getattr(services, "google", None)
    if google is None or not google.configured:
        raise NotConnected("Google isn't set up on this server")
    c = await connection(conn, venture_id)
    if c is None:
        raise NotConnected("connect Google in Settings first")
    if SCOPES["business.manage"] not in (c.scopes or []):
        raise NotConnected("reconnect Google with 'Business Profile' ticked (Reviews page) so Kritvia can post there")
    refresh = await EnvelopeCrypto(conn, services.keys).decrypt_str(venture_id, "connector.secret", c.secret_enc)
    token = await google.access_token(c.id, refresh or "")
    s = (await conn.execute(text("SELECT gbp_location, gbp_title FROM review_settings WHERE venture_id = :v"),
                            {"v": venture_id})).first()
    return Profile(token=token, location=s.gbp_location if s else None, title=s.gbp_title if s else None)


# ------------------------------------------------------------------------------------- opening hours --
WEEK = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
GOOGLE_DAYS = ("MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY")
Hours = dict[str, list[tuple[str, str]]]          # {"mon": [("10:00", "19:00")], ...}; a missing day is closed


def _hm(t: dict | None) -> str:
    t = t or {}
    h, m = int(t.get("hours", 0) or 0), int(t.get("minutes", 0) or 0)
    return "24:00" if h == 24 else f"{h:02d}:{m:02d}"


def from_google(listing: dict) -> Hours:
    out: Hours = {}
    for p in (listing.get("regularHours") or {}).get("periods", []):
        day = p.get("openDay", "")
        if day in GOOGLE_DAYS:
            out.setdefault(WEEK[GOOGLE_DAYS.index(day)], []).append((_hm(p.get("openTime")), _hm(p.get("closeTime"))))
    return {d: sorted(v) for d, v in out.items()}


def to_google(hours: Hours) -> list[dict]:
    periods = []
    for d in WEEK:
        for a, b in hours.get(d, []):
            ah, am = (int(x) for x in a.split(":"))
            bh, bm = (int(x) for x in b.split(":"))
            periods.append({"openDay": GOOGLE_DAYS[WEEK.index(d)], "openTime": {"hours": ah, "minutes": am},
                            "closeDay": GOOGLE_DAYS[WEEK.index(d)], "closeTime": {"hours": bh, "minutes": bm}})
    return periods


async def our_hours(conn, venture_id: uuid.UUID) -> tuple[Hours, str] | None:
    """The opening hours Kritvia knows: the booking hours (Bookings page) if set, else the phone assistant's
    office hours (Calls page). None when neither is set."""
    b = (await conn.execute(text("SELECT hours FROM booking_settings WHERE venture_id = :v"), {"v": venture_id})).scalar()
    if b:
        got = {d: sorted((str(x[0]), str(x[1])) for x in b.get(d, []) if len(x) == 2) for d in WEEK if b.get(d)}
        if got:
            return got, "booking hours"
    p = (await conn.execute(text("SELECT open_days, open_from, open_to FROM phone_settings WHERE venture_id = :v"),
                            {"v": venture_id})).first()
    if p is not None:
        return {WEEK[i]: [(p.open_from, p.open_to)] for i in sorted(set(p.open_days))}, "office hours (Calls page)"
    return None


def words(h: Hours) -> str:
    if not h:
        return "no hours"
    parts = []
    for d in WEEK:
        spans = h.get(d)
        parts.append(f"{d.capitalize()} {', '.join(f'{a}-{b}' for a, b in spans)}" if spans else f"{d.capitalize()} closed")
    return "; ".join(parts)
