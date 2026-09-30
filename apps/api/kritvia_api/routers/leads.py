import json
import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.deps import TenantDB, UserId
from kritvia_api.errors import raise_for_db
from kritvia_api.schemas import LeadIn, LeadOut, LeadPatch
from kritvia_api.services.crypto import EnvelopeCrypto

router = APIRouter(prefix="/ventures/{venture_id}/leads", tags=["leads"])
NOTES = "leads.notes"


def key_provider():
    from kritvia_api.engine.context import get_services
    return get_services().keys


async def _out(crypto: EnvelopeCrypto, r) -> LeadOut:
    details = await crypto.decrypt_str(r.venture_id, "leads.details", r.details_enc)
    return LeadOut(
        id=r.id, venture_id=r.venture_id, name=r.name, email=r.email, company=r.company,
        source=r.source, status=r.status, score=r.score, created_at=r.created_at,
        notes=await crypto.decrypt_str(r.venture_id, NOTES, r.notes_enc),
        phone=r.phone, priority=r.priority, budget_inr=r.budget_inr, timeline=r.timeline,
        score_reasons=r.score_reasons, inquiry_count=r.inquiry_count, last_inquiry_at=r.last_inquiry_at,
        last_run_id=r.last_run_id, details=json.loads(details) if details else None,
    )


COLS = ("id, venture_id, name, email, company, source, status, score, notes_enc, created_at, phone, priority,"
        " budget_inr, timeline, score_reasons, inquiry_count, last_inquiry_at, last_run_id, details_enc")


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
async def list_leads(venture_id: uuid.UUID, db: TenantDB, limit: int = 50) -> list[LeadOut]:
    crypto = EnvelopeCrypto(db, key_provider())
    rows = (await db.execute(
        text(f"SELECT {COLS} FROM leads WHERE venture_id = :v ORDER BY created_at DESC LIMIT :l"),
        {"v": venture_id, "l": min(max(limit, 1), 200)},
    )).all()
    return [await _out(crypto, r) for r in rows]


@router.get("/{lead_id}", response_model=LeadOut)
async def get_lead(venture_id: uuid.UUID, lead_id: uuid.UUID, db: TenantDB) -> LeadOut:
    row = (await db.execute(
        text(f"SELECT {COLS} FROM leads WHERE venture_id = :v AND id = :id"), {"v": venture_id, "id": lead_id}
    )).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "lead not found")
    return await _out(EnvelopeCrypto(db, key_provider()), row)


@router.patch("/{lead_id}", response_model=LeadOut)
async def update_lead(venture_id: uuid.UUID, lead_id: uuid.UUID, body: LeadPatch, db: TenantDB) -> LeadOut:
    crypto = EnvelopeCrypto(db, key_provider())
    fields = body.model_dump(exclude_unset=True)
    sets, params = ["updated_at = now()"], {"v": venture_id, "id": lead_id}
    for key in ("status", "score"):
        if key in fields:
            sets.append(f"{key} = :{key}")
            params[key] = fields[key]
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
