"""GST invoices made in Kritvia.

  GET/PUT /ventures/{v}/gst-profile              the business's details on every tax invoice (admins change)
  POST    /ventures/{v}/invoices/gst             issue a tax invoice: numbered, taxed per line
  GET     /ventures/{v}/invoices/{id}/document   the invoice as printed (print or save as PDF)
  GET     /public/pay/{token}/document            the same, for the customer's payment page
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import date
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.db.session import tenant_tx
from kritvia_api.deps import TenantDB, UserId, venture_org
from kritvia_api.errors import raise_for_db
from kritvia_api.ratelimit import client_ip, limiter
from kritvia_api.routers.invoices import COLS, InvoiceOut, MAX_PAISE, _clean_email, _out, pay_url, phone_digits, today_ist
from kritvia_api.services import gst

router = APIRouter(tags=["gst"])


def _gstin(v: str | None) -> str | None:
    v = re.sub(r"\s", "", v or "").upper() or None
    if v and not gst.gstin_ok(v):
        raise ValueError("that GSTIN isn't valid (15 characters, e.g. 27AAPFU0939F1ZV); check it on the GST portal")
    return v


class GstProfile(BaseModel):
    legal_name: str = Field(min_length=1, max_length=160)
    trade_name: str | None = Field(default=None, max_length=160)
    gstin: str = Field(min_length=15, max_length=20)
    address: str = Field(min_length=5, max_length=400)
    email: str | None = Field(default=None, max_length=254)
    phone: str | None = Field(default=None, max_length=24)
    prefix: str = Field(default="INV", min_length=1, max_length=5, pattern=r"^[A-Za-z0-9]+$")
    terms: str | None = Field(default=None, max_length=600, description="bank details, payment terms; printed at the foot")

    _g = field_validator("gstin")(lambda v: _gstin(v))
    _e = field_validator("email")(lambda v: _clean_email(v))


class State(BaseModel):
    code: str
    name: str


class GstProfileOut(BaseModel):
    profile: GstProfile | None
    state: State | None
    can_edit: bool
    states: list[State]
    next_number: str | None = Field(description="the number the next tax invoice will get")


STATES = [State(code=k, name=v) for k, v in gst.STATES.items()]


async def _profile(db, venture_id: uuid.UUID):
    return (await db.execute(text("SELECT * FROM gst_profiles WHERE venture_id = :v"), {"v": venture_id})).first()


@router.get("/ventures/{venture_id}/gst-profile", response_model=GstProfileOut)
async def get_profile(venture_id: uuid.UUID, db: TenantDB) -> GstProfileOut:
    await venture_org(db, venture_id)
    p = await _profile(db, venture_id)
    admin = bool((await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar())
    nxt = None
    if p:
        fy = gst.financial_year(today_ist())
        last = (await db.execute(text("SELECT last_no FROM invoice_series WHERE venture_id = :v AND fy = :f"),
                                 {"v": venture_id, "f": fy})).scalar() or 0
        nxt = gst.invoice_number(p.prefix, fy, last + 1)
    return GstProfileOut(
        profile=GstProfile(**{k: getattr(p, k) for k in GstProfile.model_fields}) if p else None,
        state=State(code=p.state_code, name=gst.STATES.get(p.state_code, p.state_code)) if p else None,
        can_edit=admin, states=STATES, next_number=nxt)


@router.put("/ventures/{venture_id}/gst-profile", response_model=GstProfileOut)
async def put_profile(venture_id: uuid.UUID, body: GstProfile, user_id: UserId, db: TenantDB) -> GstProfileOut:
    org = await venture_org(db, venture_id)
    if not (await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only the business's admins can change its GST details")
    await db.execute(text(
        "INSERT INTO gst_profiles (venture_id, org_id, legal_name, trade_name, gstin, state_code, address, email, phone,"
        " prefix, terms, updated_by) VALUES (:v, :o, :ln, :tn, :g, :sc, :a, :e, :p, :pre, :t, :u)"
        " ON CONFLICT (venture_id) DO UPDATE SET legal_name = EXCLUDED.legal_name, trade_name = EXCLUDED.trade_name,"
        " gstin = EXCLUDED.gstin, state_code = EXCLUDED.state_code, address = EXCLUDED.address, email = EXCLUDED.email,"
        " phone = EXCLUDED.phone, prefix = EXCLUDED.prefix, terms = EXCLUDED.terms, updated_by = EXCLUDED.updated_by,"
        " updated_at = now()"),
        {"v": venture_id, "o": org, "ln": body.legal_name.strip(), "tn": (body.trade_name or "").strip() or None,
         "g": body.gstin, "sc": body.gstin[:2], "a": body.address.strip(), "e": body.email,
         "p": (body.phone or "").strip() or None, "pre": body.prefix.upper(), "t": (body.terms or "").strip() or None,
         "u": user_id})
    return await get_profile(venture_id, db)


# ------------------------------------------------------------- tax invoices --
class ItemIn(BaseModel):
    description: str = Field(min_length=1, max_length=300)
    hsn_sac: str | None = Field(default=None, max_length=8, description="HSN (goods) or SAC (services) code, 4-8 digits")
    qty: Decimal = Field(gt=0, le=Decimal("999999999"), decimal_places=3)
    unit: str | None = Field(default=None, max_length=12, description="e.g. pcs, hrs, kg")
    rate_paise: int = Field(ge=0, le=MAX_PAISE, description="price per unit before GST")
    discount_paise: int = Field(default=0, ge=0, le=MAX_PAISE)
    gst_rate: Decimal

    @field_validator("hsn_sac")
    @classmethod
    def _hsn(cls, v: str | None) -> str | None:
        v = (v or "").strip() or None
        if v and not re.fullmatch(r"[0-9]{4,8}", v):
            raise ValueError("an HSN/SAC code is 4 to 8 digits")
        return v

    @field_validator("gst_rate")
    @classmethod
    def _rate(cls, v: Decimal) -> Decimal:
        if v not in gst.GST_RATES:
            raise ValueError("GST rate must be one of 0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 12, 18, 28 or 40 %")
        return v


class GstInvoiceIn(BaseModel):
    customer_name: str = Field(min_length=1, max_length=160)
    customer_gstin: str | None = Field(default=None, max_length=20, description="when the customer is GST-registered")
    customer_address: str | None = Field(default=None, max_length=400)
    place_of_supply: str | None = Field(default=None, pattern=r"^[0-9]{2}$",
                                        description="state code; defaults to the customer's GSTIN state, else yours")
    customer_email: str | None = Field(default=None, max_length=254)
    customer_phone: str | None = Field(default=None, max_length=24)
    issued_on: date | None = Field(default=None, description="defaults to today (IST)")
    due_on: date | None = Field(default=None, description="defaults to the invoice date")
    reverse_charge: bool = False
    items: list[ItemIn] = Field(min_length=1, max_length=100)
    notes: str | None = Field(default=None, max_length=1000)

    _g = field_validator("customer_gstin")(lambda v: _gstin(v))
    _e = field_validator("customer_email")(lambda v: _clean_email(v))
    _p = field_validator("customer_phone")(lambda v: phone_digits(v))


@router.post("/ventures/{venture_id}/invoices/gst", response_model=InvoiceOut, status_code=201)
async def issue(venture_id: uuid.UUID, body: GstInvoiceIn, user_id: UserId, db: TenantDB) -> InvoiceOut:
    org = await venture_org(db, venture_id)
    if not (await db.execute(text("SELECT :v = ANY (private.writable_ventures())"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "your role can see invoices but not issue them")
    p = await _profile(db, venture_id)
    if p is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Add the business's GST details first (Settings → Connectors → GST)")
    pos = body.place_of_supply or (body.customer_gstin[:2] if body.customer_gstin else p.state_code)
    if pos not in gst.STATES:
        raise HTTPException(422, "unknown place of supply")
    issued = body.issued_on or today_ist()
    due = body.due_on or issued
    if due < issued:
        raise HTTPException(422, "the due date is before the invoice date")
    same = pos == p.state_code
    lines = [gst.line_tax(i.qty, i.rate_paise, i.discount_paise, i.gst_rate, same) for i in body.items]
    taxable = sum(x.taxable for x in lines)
    cgst, sgst, igst = sum(x.cgst for x in lines), sum(x.sgst for x in lines), sum(x.igst for x in lines)
    total = taxable + cgst + sgst + igst
    if total <= 0 or total > MAX_PAISE:
        raise HTTPException(422, "the invoice total must be more than ₹0")
    fy = gst.financial_year(issued)
    supplier = {"legal_name": p.legal_name, "trade_name": p.trade_name, "gstin": p.gstin, "state_code": p.state_code,
                "address": p.address, "email": p.email, "phone": p.phone, "terms": p.terms}
    number = ""
    try:
        async with db.begin_nested():
            n = (await db.execute(text(
                "INSERT INTO invoice_series (org_id, venture_id, fy, last_no) VALUES (:o, :v, :f, 1)"
                " ON CONFLICT (venture_id, fy) DO UPDATE SET last_no = invoice_series.last_no + 1 RETURNING last_no"),
                {"o": org, "v": venture_id, "f": fy})).scalar_one()
            number = gst.invoice_number(p.prefix, fy, n)
            r = (await db.execute(text(
                "INSERT INTO invoices (org_id, venture_id, number, customer_name, customer_email, customer_phone, amount_paise,"
                " issued_on, due_on, notes, source, created_by, kind, customer_gstin, customer_address, place_of_supply,"
                " reverse_charge, taxable_paise, cgst_paise, sgst_paise, igst_paise, supplier)"
                " VALUES (:o, :v, :n, :c, :e, :ph, :a, :i, :d, :notes, 'manual', :u, 'gst', :cg, :ca, :pos, :rc, :t,"
                " :cgst, :sgst, :igst, CAST(:sup AS jsonb))"
                f" RETURNING {COLS}"),
                {"o": org, "v": venture_id, "n": number, "c": body.customer_name.strip(), "e": body.customer_email,
                 "ph": body.customer_phone, "a": total, "i": issued, "d": due, "notes": (body.notes or "").strip() or None,
                 "u": user_id, "cg": body.customer_gstin, "ca": (body.customer_address or "").strip() or None, "pos": pos,
                 "rc": body.reverse_charge, "t": taxable, "cgst": cgst, "sgst": sgst, "igst": igst,
                 "sup": json.dumps(supplier)})).first()
            for k, (item, line) in enumerate(zip(body.items, lines, strict=True), start=1):
                await db.execute(text(
                    "INSERT INTO invoice_items (org_id, venture_id, invoice_id, position, description, hsn_sac, qty, unit,"
                    " rate_paise, discount_paise, taxable_paise, gst_rate, cgst_paise, sgst_paise, igst_paise)"
                    " VALUES (:o, :v, :inv, :pos, :d, :h, :q, :u, :r, :disc, :t, :g, :c, :s, :i)"),
                    {"o": org, "v": venture_id, "inv": r.id, "pos": k, "d": item.description.strip(), "h": item.hsn_sac,
                     "q": item.qty, "u": (item.unit or "").strip() or None, "r": item.rate_paise,
                     "disc": item.discount_paise, "t": line.taxable, "g": item.gst_rate, "c": line.cgst, "s": line.sgst,
                     "i": line.igst})
    except DBAPIError as exc:
        if "invoices_number_uq" in str(exc):
            raise HTTPException(status.HTTP_409_CONFLICT, f"an invoice numbered {number} already exists; change the "
                                                          "prefix in the GST details") from None
        if "invoice_series_last_no_check" in str(exc):
            raise HTTPException(status.HTTP_409_CONFLICT, "this prefix has used all 9,999 numbers this year") from None
        raise_for_db(exc, "venture not found")
    return _out(r)


# ---------------------------------------------------------------- document --
class DocItem(BaseModel):
    position: int
    description: str
    hsn_sac: str | None
    qty: str
    unit: str | None
    rate_paise: int
    discount_paise: int
    taxable_paise: int
    gst_rate: str
    cgst_paise: int
    sgst_paise: int
    igst_paise: int


class TaxRow(BaseModel):
    hsn_sac: str | None
    gst_rate: str
    taxable_paise: int
    cgst_paise: int
    sgst_paise: int
    igst_paise: int


class Party(BaseModel):
    name: str
    trade_name: str | None = None
    gstin: str | None = None
    address: str | None = None
    state: str | None = None
    state_code: str | None = None
    email: str | None = None
    phone: str | None = None


class InvoiceDocument(BaseModel):
    title: str = Field(description="'Tax Invoice' or 'Invoice'")
    kind: str
    number: str
    issued_on: date | None
    due_on: date
    status: str
    supplier: Party
    customer: Party
    place_of_supply: State | None
    reverse_charge: bool
    items: list[DocItem]
    tax_summary: list[TaxRow]
    taxable_paise: int | None
    cgst_paise: int
    sgst_paise: int
    igst_paise: int
    total_paise: int
    paid_paise: int
    balance_paise: int
    amount_in_words: str
    terms: str | None
    notes: str | None
    pay_url: str


async def _document(conn, invoice_id: uuid.UUID, venture_id: uuid.UUID) -> InvoiceDocument:
    i = (await conn.execute(text("SELECT * FROM invoices WHERE id = :i AND venture_id = :v"),
                            {"i": invoice_id, "v": venture_id})).first()
    if i is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "invoice not found")
    items = (await conn.execute(text("SELECT * FROM invoice_items WHERE invoice_id = :i ORDER BY position"),
                                {"i": invoice_id})).all()
    biz = (await conn.execute(text("SELECT coalesce(nullif(s.business_name, ''), v.name) AS name FROM ventures v"
                                   " LEFT JOIN venture_settings s ON s.venture_id = v.id WHERE v.id = :v"),
                              {"v": venture_id})).scalar()
    sup: dict[str, Any] = i.supplier or {}
    if not sup:
        p = await _profile(conn, venture_id)
        sup = {"legal_name": p.legal_name, "trade_name": p.trade_name, "gstin": p.gstin, "state_code": p.state_code,
               "address": p.address, "email": p.email, "phone": p.phone, "terms": p.terms} if p else {"legal_name": biz}
    summary: dict[tuple, TaxRow] = {}
    for it in items:
        k = (it.hsn_sac, str(it.gst_rate.normalize()))
        row = summary.setdefault(k, TaxRow(hsn_sac=k[0], gst_rate=k[1], taxable_paise=0, cgst_paise=0, sgst_paise=0,
                                            igst_paise=0))
        row.taxable_paise += it.taxable_paise
        row.cgst_paise += it.cgst_paise
        row.sgst_paise += it.sgst_paise
        row.igst_paise += it.igst_paise
    pos = i.place_of_supply
    return InvoiceDocument(
        title="Tax Invoice" if i.kind == "gst" else "Invoice", kind=i.kind, number=i.number, issued_on=i.issued_on,
        due_on=i.due_on, status=i.status,
        supplier=Party(name=sup.get("legal_name") or biz, trade_name=sup.get("trade_name"), gstin=sup.get("gstin"),
                       address=sup.get("address"), state_code=sup.get("state_code"),
                       state=gst.STATES.get(sup.get("state_code") or ""), email=sup.get("email"), phone=sup.get("phone")),
        customer=Party(name=i.customer_name, gstin=i.customer_gstin, address=i.customer_address, email=i.customer_email,
                       phone=("+" + i.customer_phone) if i.customer_phone else None,
                       state_code=pos, state=gst.STATES.get(pos or "")),
        place_of_supply=State(code=pos, name=gst.STATES.get(pos, pos)) if pos else None,
        reverse_charge=i.reverse_charge,
        items=[DocItem(position=it.position, description=it.description, hsn_sac=it.hsn_sac,
                       qty=format(it.qty.normalize(), "f"), unit=it.unit, rate_paise=it.rate_paise,
                       discount_paise=it.discount_paise, taxable_paise=it.taxable_paise,
                       gst_rate=format(it.gst_rate.normalize(), "f"), cgst_paise=it.cgst_paise, sgst_paise=it.sgst_paise,
                       igst_paise=it.igst_paise) for it in items],
        tax_summary=list(summary.values()), taxable_paise=i.taxable_paise, cgst_paise=i.cgst_paise,
        sgst_paise=i.sgst_paise, igst_paise=i.igst_paise, total_paise=i.amount_paise, paid_paise=i.paid_paise,
        balance_paise=i.amount_paise - i.paid_paise, amount_in_words=gst.amount_in_words(i.amount_paise),
        terms=sup.get("terms"), notes=i.notes, pay_url=pay_url(i.pay_token))


@router.get("/ventures/{venture_id}/invoices/{invoice_id}/document", response_model=InvoiceDocument)
async def document(venture_id: uuid.UUID, invoice_id: uuid.UUID, db: TenantDB) -> InvoiceDocument:
    await venture_org(db, venture_id)
    return await _document(db, invoice_id, venture_id)


@router.get("/public/pay/{token}/document", response_model=InvoiceDocument)
async def public_document(token: str, request: Request) -> InvoiceDocument:
    await limiter.hit(f"pay-page:{client_ip(request)}", per_minute=60)
    async with tenant_tx(None, "system") as conn:
        r = (await conn.execute(text("SELECT * FROM private.public_invoice_document(:t)"), {"t": token})).first()
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "this invoice link isn't valid")
    async with tenant_tx(r.run_as, "agent", "payments") as conn:
        return await _document(conn, r.invoice_id, r.venture_id)
