"""Tally Prime: import a Day Book / ledger XML export; browse vouchers and who owes what."""
from __future__ import annotations

import json
import uuid
from datetime import date
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.db.session import tenant_tx
from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.errors import raise_for_db
from kritvia_api.routers.knowledge import read_upload
from kritvia_api.services import memory
from kritvia_api.services.tally import TallyParseError, parse_vouchers, render_document, summarise
from kritvia_api.services.quota import require_integration

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
        if can_write:
            await require_integration(conn, venture_id, "tally")
    if not can_write:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "venture not found")
    data = await read_upload(file, "xml")
    return await ingest(svc, user_id, org, venture_id, data, file.filename or "tally.xml")


async def ingest(svc, actor_id: uuid.UUID, org: uuid.UUID, venture_id: uuid.UUID, data: bytes,
                 filename: str) -> TallyImportOut:
    """Files a Tally export: the vouchers, and one summary document in Knowledge."""
    try:
        vouchers = parse_vouchers(data)
    except TallyParseError as exc:
        raise HTTPException(422, str(exc)) from None
    async with tenant_tx(actor_id) as conn:
        biz = (await conn.execute(text("SELECT coalesce(s.business_name, v.name) FROM ventures v"
                                       " LEFT JOIN venture_settings s ON s.venture_id = v.id WHERE v.id = :v"),
                                  {"v": venture_id})).scalar()
    summary = summarise(vouchers)
    actor = memory.UserActor(actor_id, org, venture_id, svc.router, svc.keys)
    doc_id: uuid.UUID | None = None
    try:
        res = await memory.ingest(actor, title=f"Tally {summary['from']} to {summary['to']}", kind="upload",
                                  text_override=render_document(vouchers, summary, business=biz or "the business"),
                                  filename=filename, mime="text/plain", created_by=actor_id,
                                  extract_knowledge=False, meta={"source": "tally", **summary})
        doc_id = res.document_id
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    imported = updated = 0
    async with tenant_tx(actor_id) as conn:
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
            {"o": org, "v": venture_id, "c": f"{summary['from']}..{summary['to']}", "u": actor_id})
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


# ------------------------------------------------------------------- the Tally companion (sync) --
# A small program on the PC that runs Tally (infra/tally/kritvia_tally_sync.py) talks to Tally's own XML
# server (localhost:9000) and to these endpoints, every hour: it sends Tally's Day Book here, and takes
# Kritvia's new invoices into Tally as Sales vouchers. It authenticates with the business's sync key.
class SyncKeyOut(BaseModel):
    connector_id: uuid.UUID
    key: str
    hook_url: str


class SyncSettings(BaseModel):
    sales_ledger: str = "Sales"
    cgst_ledger: str = "CGST"
    sgst_ledger: str = "SGST"
    igst_ledger: str = "IGST"
    round_off_ledger: str = "Round Off"


class SyncStatusOut(BaseModel):
    connected: bool
    has_key: bool
    last_sync: str | None
    waiting_invoices: int
    ledgers: SyncSettings


@router.get("/ventures/{venture_id}/connectors/tally/sync", response_model=SyncStatusOut)
async def sync_status(venture_id: uuid.UUID, db: TenantDB) -> SyncStatusOut:
    await venture_org(db, venture_id)
    c = (await db.execute(text("SELECT id, cursor, meta, status FROM connectors WHERE venture_id = :v AND provider = 'tally'"),
                          {"v": venture_id})).first()
    has_key = bool(c and (c.meta or {}).get("sync_key"))
    waiting = (await db.execute(text("SELECT count(*) FROM invoices WHERE venture_id = :v AND status IN ('open', 'paid')"
                                     " AND tally_synced_at IS NULL AND source <> 'tally'"), {"v": venture_id})).scalar()
    meta = dict(c.meta or {}) if c else {}
    return SyncStatusOut(connected=bool(c and c.status == "active"), has_key=has_key,
                         last_sync=meta.get("last_sync"), waiting_invoices=int(waiting or 0),
                         ledgers=SyncSettings(**(meta.get("ledgers") or {})))


@router.post("/ventures/{venture_id}/connectors/tally/sync-key", response_model=SyncKeyOut)
async def make_sync_key(venture_id: uuid.UUID, user_id: UserId, db: TenantDB, svc: Svc) -> SyncKeyOut:
    """A new sync key for the Tally companion (the old one stops working). Shown once."""
    import hashlib
    import secrets

    from kritvia_api.config import get_settings
    from kritvia_api.services.crypto import EnvelopeCrypto
    from kritvia_api.services.quota import require_integration
    org = await venture_org(db, venture_id)
    if not (await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only the business's admins can set up the Tally sync")
    await require_integration(db, venture_id, "tally")
    key = "kts_" + secrets.token_urlsafe(32)
    cid = (await db.execute(text(
        "INSERT INTO connectors (org_id, venture_id, provider, status, created_by, meta)"
        " VALUES (:o, :v, 'tally', 'active', :u, jsonb_build_object('sync_key', true))"
        " ON CONFLICT (venture_id, provider) DO UPDATE SET status = 'active', updated_at = now(),"
        " meta = connectors.meta || jsonb_build_object('sync_key', true) RETURNING id"),
        {"o": org, "v": venture_id, "u": user_id})).scalar_one()
    enc = await EnvelopeCrypto(db, svc.keys).encrypt(venture_id, "connector.secret",
                                                     hashlib.sha256(key.encode()).hexdigest())
    await db.execute(text(
        "INSERT INTO connector_tokens (connector_id, org_id, venture_id, secret_enc) VALUES (:c, :o, :v, :s)"
        " ON CONFLICT (connector_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, updated_at = now()"),
        {"c": cid, "o": org, "v": venture_id, "s": enc})
    return SyncKeyOut(connector_id=cid, key=key,
                      hook_url=f"{get_settings().public_api_url.rstrip('/')}/hooks/tally/{cid}")


@router.put("/ventures/{venture_id}/connectors/tally/ledgers", response_model=SyncSettings)
async def set_ledgers(venture_id: uuid.UUID, body: SyncSettings, db: TenantDB) -> SyncSettings:
    """The Tally ledger names Kritvia's invoices are posted to (they must exist in Tally)."""
    await venture_org(db, venture_id)
    if not (await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only the business's admins can change this")
    clean = {k: (v or "").strip()[:100] or SyncSettings.model_fields[k].default for k, v in body.model_dump().items()}
    r = await db.execute(text("UPDATE connectors SET meta = meta || jsonb_build_object('ledgers', CAST(:l AS jsonb)),"
                              " updated_at = now() WHERE venture_id = :v AND provider = 'tally'"),
                         {"l": json.dumps(clean), "v": venture_id})
    if not r.rowcount:
        raise HTTPException(status.HTTP_409_CONFLICT, "set up the Tally sync first")
    return SyncSettings(**clean)


async def _companion(request, connector_id: uuid.UUID, svc):
    """The business behind a companion call, once its sync key checks out."""
    import hashlib
    import hmac

    from kritvia_api.ratelimit import client_ip, limiter
    from kritvia_api.services.crypto import EnvelopeCrypto
    from kritvia_api.services.security_log import security_event
    await limiter.hit(f"tally-hook:{connector_id}", per_minute=30)
    await limiter.hit(f"tally-hook-ip:{client_ip(request)}", per_minute=60)
    key = (request.headers.get("x-kritvia-key") or "").strip()
    async with tenant_tx(None, "system") as conn:
        p = (await conn.execute(text("SELECT * FROM private.tally_principal(:c)"), {"c": connector_id})).first()
    if p is None or p.run_as is None or not key:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown Tally sync")
    async with tenant_tx(p.run_as) as conn:
        enc = (await conn.execute(text("SELECT secret_enc FROM connector_tokens WHERE connector_id = :c"),
                                  {"c": connector_id})).scalar()
        want = await EnvelopeCrypto(conn, svc.keys).decrypt_str(p.venture_id, "connector.secret", enc) if enc else None
    if not want or not hmac.compare_digest(want, hashlib.sha256(key.encode()).hexdigest()):
        await security_event("webhook.bad_signature", "warning", request=request, org_id=p.org_id, provider="tally")
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong sync key; make a new one on the Money page")
    return p


@router.post("/hooks/tally/{connector_id}/import", response_model=TallyImportOut, status_code=201)
async def companion_import(connector_id: uuid.UUID, request: Request, svc: Svc) -> TallyImportOut:
    """The companion's Day Book export from Tally (raw XML body)."""
    p = await _companion(request, connector_id, svc)
    data = await request.body()
    if len(data) > 40 * 1024 * 1024:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "export larger than 40 MB")
    out = await ingest(svc, p.run_as, p.org_id, p.venture_id, data, "tally-sync.xml")
    async with tenant_tx(p.run_as) as conn:
        await conn.execute(text("UPDATE connectors SET meta = meta || jsonb_build_object('last_sync', now()::text)"
                                " WHERE id = :c"), {"c": connector_id})
    return out


class SalesOut(BaseModel):
    vouchers: list[dict[str, str]]


@router.get("/hooks/tally/{connector_id}/sales", response_model=SalesOut)
async def companion_sales(connector_id: uuid.UUID, request: Request, svc: Svc) -> SalesOut:
    """Kritvia's invoices Tally doesn't have yet, each as a ready Tally import request (oldest first, 100 at a
    time). The companion posts each one to Tally and acknowledges the ones Tally created."""
    from kritvia_api.services.tally import sales_voucher_xml
    p = await _companion(request, connector_id, svc)
    async with tenant_tx(p.run_as) as conn:
        meta = (await conn.execute(text("SELECT meta FROM connectors WHERE id = :c"), {"c": connector_id})).scalar() or {}
        rows = (await conn.execute(text(
            "SELECT id, number, customer_name, customer_gstin, amount_paise, coalesce(issued_on, created_at::date)"
            " AS issued_on, kind, taxable_paise, cgst_paise, sgst_paise, igst_paise FROM invoices"
            " WHERE venture_id = :v AND status IN ('open', 'paid') AND tally_synced_at IS NULL AND source <> 'tally'"
            " ORDER BY coalesce(issued_on, created_at::date), created_at LIMIT 100"), {"v": p.venture_id})).all()
    led = SyncSettings(**(dict(meta).get("ledgers") or {}))
    ledgers = {"sales": led.sales_ledger, "cgst": led.cgst_ledger, "sgst": led.sgst_ledger, "igst": led.igst_ledger,
               "round_off": led.round_off_ledger}
    return SalesOut(vouchers=[{"invoice_id": str(r.id), "number": r.number or "",
                               "xml": sales_voucher_xml(dict(r._mapping), ledgers)} for r in rows])


class AckIn(BaseModel):
    invoice_ids: list[uuid.UUID] = Field(max_length=100)


@router.post("/hooks/tally/{connector_id}/sales/ack")
async def companion_ack(connector_id: uuid.UUID, body: AckIn, request: Request, svc: Svc) -> dict:
    p = await _companion(request, connector_id, svc)
    async with tenant_tx(p.run_as) as conn:
        r = await conn.execute(text("UPDATE invoices SET tally_synced_at = now() WHERE venture_id = :v"
                                    " AND id = ANY(:ids) AND tally_synced_at IS NULL"),
                               {"v": p.venture_id, "ids": body.invoice_ids})
    return {"synced": r.rowcount or 0}
