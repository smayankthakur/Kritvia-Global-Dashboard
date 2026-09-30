"""Sitelytc: rate card, inbound inquiries, proposals."""
from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.db.session import tenant_tx
from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.engine.runner import start_run
from kritvia_api.errors import raise_for_db
from kritvia_api.services.crypto import EnvelopeCrypto

router = APIRouter(tags=["sitelytc"])


class RateItem(BaseModel):
    code: str = Field(pattern=r"^[a-z0-9_]{2,40}$")
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=1000)
    unit: Literal["project", "page", "screen", "integration", "hour", "month", "workflow", "assessment", "item"]
    rate_inr: Decimal = Field(ge=0, max_digits=14, decimal_places=2)
    min_units: Decimal = Field(default=Decimal(1), gt=0)
    active: bool = True


class RateCardIn(BaseModel):
    items: list[RateItem] = Field(max_length=200)


@router.get("/ventures/{venture_id}/rate-card", response_model=list[RateItem])
async def get_rate_card(venture_id: uuid.UUID, db: TenantDB) -> list[RateItem]:
    rows = (await db.execute(text(
        "SELECT code, name, description, unit, rate_inr, min_units, active FROM rate_cards WHERE venture_id = :v"
        " ORDER BY code"), {"v": venture_id})).all()
    return [RateItem(**r._mapping) for r in rows]


@router.put("/ventures/{venture_id}/rate-card", response_model=list[RateItem])
async def put_rate_card(venture_id: uuid.UUID, body: RateCardIn, db: TenantDB) -> list[RateItem]:
    """Upsert items by code; codes not in the list are deactivated (history stays intact)."""
    org = await venture_org(db, venture_id)
    try:
        async with db.begin_nested():
            codes = [i.code for i in body.items]
            await db.execute(text("UPDATE rate_cards SET active = false, updated_at = now()"
                                  " WHERE venture_id = :v AND NOT (code = ANY(:c))"), {"v": venture_id, "c": codes})
            for i in body.items:
                await db.execute(text(
                    "INSERT INTO rate_cards (org_id, venture_id, code, name, description, unit, rate_inr, min_units,"
                    " active) VALUES (:o, :v, :code, :n, :d, :u, :r, :m, :a) ON CONFLICT (venture_id, code) DO UPDATE"
                    " SET name = EXCLUDED.name, description = EXCLUDED.description, unit = EXCLUDED.unit,"
                    " rate_inr = EXCLUDED.rate_inr, min_units = EXCLUDED.min_units, active = EXCLUDED.active,"
                    " updated_at = now()"),
                    {"o": org, "v": venture_id, "code": i.code, "n": i.name, "d": i.description, "u": i.unit,
                     "r": i.rate_inr, "m": i.min_units, "a": i.active})
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    return await get_rate_card(venture_id, db)


class InquiryIn(BaseModel):
    from_name: str | None = Field(default=None, max_length=200)
    from_email: EmailStr | None = None
    company: str | None = Field(default=None, max_length=200)
    subject: str | None = Field(default=None, max_length=300)
    body: str = Field(min_length=3, max_length=20000)
    source: Literal["manual", "referral", "email", "webhook"] = "manual"


class StartedOut(BaseModel):
    run_id: uuid.UUID


@router.post("/ventures/{venture_id}/leads/inquiry", response_model=StartedOut, status_code=202)
async def inquiry(venture_id: uuid.UUID, body: InquiryIn, user_id: UserId, svc: Svc) -> StartedOut:
    """Paste an inquiry (from WhatsApp, a call, a referral) and let the triage workflow take it."""
    try:
        run_id = await start_run(svc, actor_user_id=user_id, venture_id=venture_id, workflow="lead_triage",
                                 input=body.model_dump(mode="json"), trigger_kind="manual",
                                 title=f"Inquiry: {body.company or body.from_name or body.from_email or 'unknown'}")
    except LookupError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "venture not found") from None
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    return StartedOut(run_id=run_id)


class ProposalOut(BaseModel):
    id: uuid.UUID
    lead_id: uuid.UUID
    lead_name: str | None
    run_id: uuid.UUID | None
    title: str
    status: str
    line_items: list[dict[str, Any]]
    subtotal_inr: Decimal
    gst_inr: Decimal
    total_inr: Decimal
    reference: dict[str, Any]
    citations: list[dict[str, Any]]
    sent_at: datetime | None
    created_at: datetime
    content: str | None = None


PCOLS = ("p.id, p.lead_id, l.name AS lead_name, p.run_id, p.title, p.status, p.line_items, p.subtotal_inr, p.gst_inr,"
         " p.total_inr, p.reference, p.citations, p.sent_at, p.created_at, p.content_enc, p.venture_id")


@router.get("/ventures/{venture_id}/proposals", response_model=list[ProposalOut])
async def list_proposals(venture_id: uuid.UUID, db: TenantDB, lead_id: uuid.UUID | None = None) -> list[ProposalOut]:
    q = f"SELECT {PCOLS} FROM proposals p LEFT JOIN leads l ON l.id = p.lead_id WHERE p.venture_id = :v"
    params: dict[str, Any] = {"v": venture_id}
    if lead_id:
        q += " AND p.lead_id = :l"
        params["l"] = lead_id
    rows = (await db.execute(text(q + " ORDER BY p.created_at DESC LIMIT 200"), params)).all()
    return [ProposalOut(**{k: v for k, v in r._mapping.items() if k not in ("content_enc", "venture_id")})
            for r in rows]


@router.get("/ventures/{venture_id}/proposals/{proposal_id}", response_model=ProposalOut)
async def get_proposal(venture_id: uuid.UUID, proposal_id: uuid.UUID, db: TenantDB, svc: Svc) -> ProposalOut:
    r = (await db.execute(text(f"SELECT {PCOLS} FROM proposals p LEFT JOIN leads l ON l.id = p.lead_id"
                               " WHERE p.venture_id = :v AND p.id = :id"), {"v": venture_id, "id": proposal_id})).first()
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "proposal not found")
    content = (await EnvelopeCrypto(db, svc.keys).decrypt(venture_id, "proposals.content", r.content_enc)).decode()
    return ProposalOut(**{k: v for k, v in r._mapping.items() if k not in ("content_enc", "venture_id")},
                       content=content)


class ProposalStatusIn(BaseModel):
    status: Literal["accepted", "rejected"]


@router.post("/ventures/{venture_id}/proposals/{proposal_id}/outcome", response_model=ProposalOut)
async def proposal_outcome(venture_id: uuid.UUID, proposal_id: uuid.UUID, body: ProposalStatusIn, user_id: UserId,
                           svc: Svc) -> ProposalOut:
    """Record whether the client accepted — feeds win-rate and the 'similar past projects' price reference."""
    async with tenant_tx(user_id) as conn:
        try:
            async with conn.begin_nested():
                row = (await conn.execute(text(
                    "UPDATE proposals SET status = :s WHERE id = :id AND venture_id = :v AND status = 'sent'"
                    " RETURNING lead_id"), {"s": body.status, "id": proposal_id, "v": venture_id})).first()
                if row:
                    await conn.execute(text("UPDATE leads SET status = :s, updated_at = now() WHERE id = :l"),
                                       {"s": "won" if body.status == "accepted" else "lost", "l": row.lead_id})
        except DBAPIError as exc:
            raise_for_db(exc, "proposal not found")
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "no sent proposal with that id")
    async with tenant_tx(user_id) as conn:
        return await get_proposal(venture_id, proposal_id, conn, svc)
