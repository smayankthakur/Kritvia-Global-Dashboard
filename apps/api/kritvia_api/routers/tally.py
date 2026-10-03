"""Tally Prime: import a Day Book / ledger XML export; browse vouchers and who owes what."""
from __future__ import annotations

import json
import uuid
from datetime import date
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, File, HTTPException, Query, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.db.session import tenant_tx
from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.errors import raise_for_db
from kritvia_api.routers.knowledge import read_upload
from kritvia_api.services import memory
from kritvia_api.services.tally import TallyParseError, parse_vouchers, render_document, summarise

router = APIRouter(tags=["tally"])


class TallyImportOut(BaseModel):
    imported: int
    updated: int
    period_from: date
    period_to: date
    document_id: uuid.UUID | None
    by_type: dict[str, dict[str, str | int]]
    outstanding: dict[str, str]


@router.post("/ventures/{venture_id}/connectors/tally/import", response_model=TallyImportOut, status_code=201)
async def import_tally(venture_id: uuid.UUID, user_id: UserId, svc: Svc, file: UploadFile = File(...)) -> TallyImportOut:
    """Upload a Tally XML export. Vouchers are upserted by GUID (re-importing an overlapping
    period is safe) and a summary document is filed in Knowledge so answers cite it."""
    async with tenant_tx(user_id) as conn:
        org = await venture_org(conn, venture_id)
        can_write = (await conn.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar()
        biz = (await conn.execute(text("SELECT coalesce(s.business_name, v.name) FROM ventures v"
                                       " LEFT JOIN venture_settings s ON s.venture_id = v.id WHERE v.id = :v"),
                                  {"v": venture_id})).scalar()
    if not can_write:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "venture not found")
    data = await read_upload(file)
    try:
        vouchers = parse_vouchers(data)
    except TallyParseError as exc:
        raise HTTPException(422, str(exc)) from None
    summary = summarise(vouchers)
    actor = memory.UserActor(user_id, org, venture_id, svc.router, svc.keys)
    doc_id: uuid.UUID | None = None
    try:
        res = await memory.ingest(actor, title=f"Tally {summary['from']} to {summary['to']}", kind="upload",
                                  text_override=render_document(vouchers, summary, business=biz or "the business"),
                                  filename=file.filename or "tally.xml", mime="text/plain", created_by=user_id,
                                  extract_knowledge=False, meta={"source": "tally", **summary})
        doc_id = res.document_id
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    imported = updated = 0
    async with tenant_tx(user_id) as conn:
        for v in vouchers:
            row = (await conn.execute(text(
                "INSERT INTO tally_vouchers (org_id, venture_id, document_id, guid, voucher_type, voucher_number,"
                " voucher_date, party, narration, amount_inr, ledgers)"
                " VALUES (:o, :v, :d, :g, :t, :n, :dt, :p, :na, :a, CAST(:l AS jsonb))"
                " ON CONFLICT (venture_id, guid) DO UPDATE SET document_id = EXCLUDED.document_id,"
                " voucher_type = EXCLUDED.voucher_type, voucher_number = EXCLUDED.voucher_number,"
                " voucher_date = EXCLUDED.voucher_date, party = EXCLUDED.party, narration = EXCLUDED.narration,"
                " amount_inr = EXCLUDED.amount_inr, ledgers = EXCLUDED.ledgers, imported_at = now()"
                " RETURNING (xmax = 0) AS inserted"),
                {"o": org, "v": venture_id, "d": doc_id, "g": v.guid, "t": v.voucher_type, "n": v.number,
                 "dt": v.day, "p": v.party, "na": v.narration, "a": v.amount, "l": json.dumps(v.ledgers)})).first()
            if row and row.inserted:
                imported += 1
            else:
                updated += 1
        await conn.execute(text(
            "INSERT INTO connectors (org_id, venture_id, provider, status, cursor, created_by)"
            " VALUES (:o, :v, 'tally', 'active', :c, :u)"
            " ON CONFLICT (venture_id, provider) DO UPDATE SET status = 'active', cursor = EXCLUDED.cursor,"
            " last_error = NULL, updated_at = now()"),
            {"o": org, "v": venture_id, "c": f"{summary['from']}..{summary['to']}", "u": user_id})
    return TallyImportOut(imported=imported, updated=updated, period_from=date.fromisoformat(summary["from"]),
                          period_to=date.fromisoformat(summary["to"]), document_id=doc_id,
                          by_type=summary["by_type"], outstanding=summary["outstanding"])


class VoucherOut(BaseModel):
    id: uuid.UUID
    voucher_type: str
    voucher_number: str | None
    voucher_date: date
    party: str | None
    narration: str | None
    amount_inr: Decimal


class PartyBalance(BaseModel):
    party: str
    billed_inr: Decimal
    received_inr: Decimal
    outstanding_inr: Decimal
    last_voucher: date


class TallyOverviewOut(BaseModel):
    vouchers: int
    period_from: date | None
    period_to: date | None
    by_type: list[dict[str, Any]]
    receivables: list[PartyBalance]
    recent: list[VoucherOut]


@router.get("/ventures/{venture_id}/tally", response_model=TallyOverviewOut)
async def overview(venture_id: uuid.UUID, db: TenantDB, q: str | None = Query(default=None, max_length=100),
                   limit: int = Query(default=50, ge=1, le=500)) -> TallyOverviewOut:
    await venture_org(db, venture_id)
    head = (await db.execute(text("SELECT count(*) AS n, min(voucher_date) AS first_day, max(voucher_date) AS last_day"
                                  " FROM tally_vouchers WHERE venture_id = :v"), {"v": venture_id})).first()
    by_type = (await db.execute(text(
        "SELECT voucher_type, count(*) AS count, sum(amount_inr) AS total FROM tally_vouchers"
        " WHERE venture_id = :v GROUP BY voucher_type ORDER BY total DESC"), {"v": venture_id})).all()
    recv = (await db.execute(text(
        "SELECT party, sum(CASE WHEN lower(voucher_type) LIKE 'sales%' THEN amount_inr ELSE 0 END) AS billed,"
        " sum(CASE WHEN lower(voucher_type) = 'receipt' THEN amount_inr ELSE 0 END) AS received,"
        " max(voucher_date) AS last_voucher FROM tally_vouchers WHERE venture_id = :v AND party IS NOT NULL"
        " GROUP BY party HAVING sum(CASE WHEN lower(voucher_type) LIKE 'sales%' THEN amount_inr"
        " WHEN lower(voucher_type) = 'receipt' THEN -amount_inr ELSE 0 END) > 0"
        " ORDER BY 2 - 3 DESC LIMIT 100"), {"v": venture_id})).all()
    params: dict[str, Any] = {"v": venture_id, "l": limit}
    where = ""
    if q:
        where = " AND (party ILIKE :q OR narration ILIKE :q OR voucher_number ILIKE :q)"
        params["q"] = f"%{q}%"
    recent = (await db.execute(text(
        "SELECT id, voucher_type, voucher_number, voucher_date, party, narration, amount_inr FROM tally_vouchers"
        f" WHERE venture_id = :v{where} ORDER BY voucher_date DESC, imported_at DESC LIMIT :l"), params)).all()
    return TallyOverviewOut(
        vouchers=head.n, period_from=head.first_day, period_to=head.last_day,
        by_type=[{"voucher_type": r.voucher_type, "count": r.count, "total_inr": str(r.total)} for r in by_type],
        receivables=[PartyBalance(party=r.party, billed_inr=r.billed, received_inr=r.received,
                                  outstanding_inr=r.billed - r.received, last_voucher=r.last_voucher) for r in recv],
        recent=[VoucherOut(**r._mapping) for r in recent])
