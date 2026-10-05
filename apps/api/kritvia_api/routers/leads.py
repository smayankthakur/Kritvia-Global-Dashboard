import asyncio
import json
import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.deps import TenantDB, UserId
from kritvia_api.errors import raise_for_db
from kritvia_api.schemas import LeadIn, LeadOut, LeadOutreachIn, LeadPatch, PlaceOut
from kritvia_api.services.crypto import EnvelopeCrypto

router = APIRouter(prefix="/ventures/{venture_id}/leads", tags=["leads"])
NOTES = "leads.notes"


def key_provider():
    from kritvia_api.engine.context import get_services
    return get_services().keys


LIVE_LIST_MAX = 60      # prospects named live in one list response (each is a Google lookup)


async def _place(place_id: str, *, name_only: bool) -> tuple[PlaceOut | None, str | None]:
    """The business as Google Maps shows it now (never stored: Google's terms allow only the ID)."""
    from kritvia_api.engine.context import get_services
    from kritvia_api.services.places import PlacesError
    places = get_services().places
    if places is None or not places.configured:
        return None, "Google Maps lookups are not set up on this server"
    try:
        p = await places.details(place_id, name_only=name_only)
    except PlacesError as exc:
        return None, str(exc)[:200]
    return PlaceOut(name=p.name, phone=p.phone, address=p.address, website=p.website, rating=p.rating,
                    review_count=p.review_count, category=p.category, maps_url=p.maps_url, status=p.status), None


async def _out(crypto: EnvelopeCrypto, r, *, place: PlaceOut | None = None, place_error: str | None = None) -> LeadOut:
    from kritvia_api.workflows.prospector import whatsapp_link
    details = await crypto.decrypt_str(r.venture_id, "leads.details", r.details_enc)
    draft = await crypto.decrypt_str(r.venture_id, "leads.outreach", r.outreach_draft_enc)
    phone = r.phone or (place.phone if place else None)
    return LeadOut(
        id=r.id, venture_id=r.venture_id, name=r.name, email=r.email, company=r.company,
        source=r.source, status=r.status, score=r.score, created_at=r.created_at,
        notes=await crypto.decrypt_str(r.venture_id, NOTES, r.notes_enc),
        phone=r.phone, priority=r.priority, budget_inr=r.budget_inr, timeline=r.timeline,
        score_reasons=r.score_reasons, inquiry_count=r.inquiry_count, last_inquiry_at=r.last_inquiry_at,
        last_run_id=r.last_run_id, details=json.loads(details) if details else None,
        place_id=r.place_id, place_search=r.place_search, website_kind=r.website_kind, place=place,
        place_error=place_error, outreach_step=r.outreach_step, next_touch_at=r.next_touch_at,
        last_touch_at=r.last_touch_at, last_touch_channel=r.last_touch_channel, replied_at=r.replied_at,
        opted_out_at=r.opted_out_at, outreach_draft=draft,
        whatsapp_link=whatsapp_link(phone, draft) if phone and not r.opted_out_at else None,
    )


COLS = ("id, venture_id, name, email, company, source, status, score, notes_enc, created_at, phone, priority,"
        " budget_inr, timeline, score_reasons, inquiry_count, last_inquiry_at, last_run_id, details_enc,"
        " place_id, place_search, website_kind, outreach_step, next_touch_at, last_touch_at,"
        " last_touch_channel, replied_at, opted_out_at, outreach_draft_enc")


@router.post("", response_model=LeadOut, status_code=201)
async def create_lead(venture_id: uuid.UUID, body: LeadIn, user_id: UserId, db: TenantDB) -> LeadOut:
    crypto = EnvelopeCrypto(db, key_provider())
    try:
        async with db.begin_nested():
            # org_id is derived from the venture row the caller can SEE; if RLS
            # hides the venture, nothing is inserted and we return 404.
            notes = await crypto.encrypt(venture_id, NOTES, body.notes) if body.notes else None
            row = (await db.execute(
                text(
                    "INSERT INTO leads (org_id, venture_id, name, email, company, source, notes_enc, created_by)"
                    " SELECT org_id, id, :n, :e, :c, :s, :notes, :u FROM ventures WHERE id = :v"
                    f" RETURNING {COLS}"
                ),
                {"v": venture_id, "n": body.name, "e": body.email, "c": body.company,
                 "s": body.source, "notes": notes, "u": user_id},
            )).first()
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "venture not found")
    return await _out(crypto, row)


@router.get("", response_model=list[LeadOut])
async def list_leads(venture_id: uuid.UUID, db: TenantDB, limit: int = 50, live: bool = False) -> list[LeadOut]:
    """`live=true` also names prospects from Google Maps (one lookup each, the first LIVE_LIST_MAX)."""
    crypto = EnvelopeCrypto(db, key_provider())
    rows = (await db.execute(
        text(f"SELECT {COLS} FROM leads WHERE venture_id = :v ORDER BY created_at DESC LIMIT :l"),
        {"v": venture_id, "l": min(max(limit, 1), 200)},
    )).all()
    places: dict[uuid.UUID, tuple[PlaceOut | None, str | None]] = {}
    if live:
        todo = [r for r in rows if r.place_id and not r.opted_out_at][:LIVE_LIST_MAX]
        gate = asyncio.Semaphore(8)

        async def one(r):
            async with gate:
                places[r.id] = await _place(r.place_id, name_only=True)
        await asyncio.gather(*(one(r) for r in todo))
    return [await _out(crypto, r, place=places.get(r.id, (None, None))[0],
                       place_error=places.get(r.id, (None, None))[1]) for r in rows]


@router.get("/{lead_id}", response_model=LeadOut)
async def get_lead(venture_id: uuid.UUID, lead_id: uuid.UUID, db: TenantDB) -> LeadOut:
    row = (await db.execute(
        text(f"SELECT {COLS} FROM leads WHERE venture_id = :v AND id = :id"), {"v": venture_id, "id": lead_id}
    )).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "lead not found")
    place, err = (await _place(row.place_id, name_only=False)) if row.place_id and not row.opted_out_at else (None, None)
    return await _out(EnvelopeCrypto(db, key_provider()), row, place=place, place_error=err)


@router.patch("/{lead_id}", response_model=LeadOut)
async def update_lead(venture_id: uuid.UUID, lead_id: uuid.UUID, body: LeadPatch, db: TenantDB) -> LeadOut:
    crypto = EnvelopeCrypto(db, key_provider())
    fields = body.model_dump(exclude_unset=True)
    sets, params = ["updated_at = now()"], {"v": venture_id, "id": lead_id}
    if fields.get("phone"):
        from kritvia_api.workflows.prospector import norm_phone
        fields["phone"] = norm_phone(fields["phone"]) or fields["phone"].strip()
    if fields.get("name") is not None:
        fields["name"] = fields["name"].strip() or None
    for key in ("status", "score", "email", "name", "phone"):
        if key in fields and not (key in ("name", "status") and fields[key] is None):
            sets.append(f"{key} = :{key}")
            params[key] = fields[key].strip().lower() if key == "email" and fields[key] else fields[key]
    try:
        async with db.begin_nested():
            if "notes" in fields:
                sets.append("notes_enc = :notes")
                params["notes"] = (await crypto.encrypt(venture_id, NOTES, fields["notes"])
                                   if fields["notes"] else None)
            row = (await db.execute(
                text(f"UPDATE leads SET {', '.join(sets)} WHERE venture_id = :v AND id = :id RETURNING {COLS}"),
                params,
            )).first()
    except DBAPIError as exc:
        raise_for_db(exc, "lead not found")
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "lead not found")
    return await _out(crypto, row)


@router.delete("/{lead_id}", status_code=204)
async def delete_lead(venture_id: uuid.UUID, lead_id: uuid.UUID, db: TenantDB) -> None:
    try:
        res = await db.execute(
            text("DELETE FROM leads WHERE venture_id = :v AND id = :id"), {"v": venture_id, "id": lead_id}
        )
    except DBAPIError as exc:
        raise_for_db(exc, "lead not found")
    if res.rowcount == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "lead not found")


@router.post("/{lead_id}/outreach", response_model=LeadOut)
async def lead_outreach(venture_id: uuid.UUID, lead_id: uuid.UUID, body: LeadOutreachIn, db: TenantDB) -> LeadOut:
    """What the owner did about a prospect: sent the WhatsApp message, called them, skipped this message,
    picked the sequence up again, or opted them out at their request."""
    from kritvia_api.workflows.prospector import next_touch, prospector_settings
    lead = (await db.execute(text(
        "SELECT outreach_step, opted_out_at, replied_at FROM leads WHERE venture_id = :v AND id = :id"),
        {"v": venture_id, "id": lead_id})).first()
    if lead is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "lead not found")
    if lead.opted_out_at and body.action != "opt_out":
        raise HTTPException(status.HTTP_409_CONFLICT, "this business asked not to be contacted")
    params: dict = {"v": venture_id, "id": lead_id}
    if body.action in ("whatsapp_sent", "called"):
        step = int(lead.outreach_step) + 1
        params |= {"s": step, "c": "whatsapp" if body.action == "whatsapp_sent" else "call",
                   "n": None if lead.replied_at else next_touch(step, await prospector_settings(db, venture_id))}
        sql = ("outreach_step = :s, last_touch_at = now(), last_touch_channel = :c, outreach_draft_enc = NULL,"
               " next_touch_at = :n, status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END")
    elif body.action == "replied":   # they answered on WhatsApp or the phone: stop the follow-ups
        sql = ("replied_at = coalesce(replied_at, now()), next_touch_at = NULL, outreach_draft_enc = NULL,"
               " status = CASE WHEN status IN ('new', 'contacted') THEN 'replied' ELSE status END")
    elif body.action == "skip":
        sql = "outreach_draft_enc = NULL, next_touch_at = NULL"
    elif body.action == "resume":
        if lead.replied_at:
            raise HTTPException(status.HTTP_409_CONFLICT, "they replied; answer them instead of restarting")
        sql = "next_touch_at = now()"
    else:
        sql = ("opted_out_at = coalesce(opted_out_at, now()), next_touch_at = NULL, outreach_draft_enc = NULL,"
               " status = CASE WHEN status IN ('new', 'contacted', 'replied') THEN 'lost' ELSE status END")
    try:
        row = (await db.execute(text(
            f"UPDATE leads SET {sql}, updated_at = now() WHERE venture_id = :v AND id = :id RETURNING {COLS}"),
            params)).first()
    except DBAPIError as exc:
        raise_for_db(exc, "lead not found")
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "lead not found")
    return await _out(EnvelopeCrypto(db, key_provider()), row)
