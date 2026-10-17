"""Trade: shipment files for exporters, importers and C&F agents.

  GET/PUT /ventures/{v}/trade-profile                 details printed on export documents (admins change them)
  GET     /ventures/{v}/shipments                     files with what needs attention today
  POST    /ventures/{v}/shipments                     open a file (numbered EXP/26-27/0001, IMP/…, JOB/…)
  GET     /ventures/{v}/shipments/{id}                one file: lines, packing list, checklist, timeline, alerts
  PATCH   /ventures/{v}/shipments/{id}                change details or move the stage
  DELETE  /ventures/{v}/shipments/{id}                admins
  PUT     /ventures/{v}/shipments/{id}/items          invoice lines (the value follows them)
  PUT     /ventures/{v}/shipments/{id}/packages       packing list
  POST    /ventures/{v}/shipments/{id}/docs           add a document to the checklist; PATCH/DELETE /docs/{doc_id}
  POST    /ventures/{v}/shipments/{id}/notes          a note on the timeline
  POST    /ventures/{v}/shipments/{id}/update         draft a status update to the party (waits for a yes)
  POST    /ventures/{v}/shipments/{id}/bill           a C&F job's bill to the client (an invoice: fee + reimbursables)
"""
from __future__ import annotations

import re
import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.errors import raise_for_db
from kritvia_api.services import trade as tr

router = APIRouter(tags=["trade"])
Direction = Literal["export", "import"]
Stage = Literal["order", "production", "booking", "documents", "customs", "cleared", "duty_paid", "shipped",
                "arrived", "delivered", "paid", "closed", "cancelled"]
Incoterm = Literal["EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"]
Mode = Literal["sea", "air", "road", "rail", "courier"]
Terms = Literal["advance", "lc", "dp", "da", "cad", "open", "other"]
Role = Literal["exporter", "importer", "cha"]
MAX_MINOR = 10 ** 15
IST = ZoneInfo("Asia/Kolkata")


def _email(v: str | None) -> str | None:
    v = (v or "").strip().lower() or None
    if v and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", v):
        raise ValueError("that email address doesn't look right")
    return v


def _upper(v: str | None) -> str | None:
    v = (v or "").strip().upper() or None
    return v


async def _writer(db, venture_id: uuid.UUID) -> uuid.UUID:
    org = await venture_org(db, venture_id)
    if not (await db.execute(text("SELECT :v = ANY (private.writable_ventures())"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "your role can see shipments but not change them")
    return org


async def _admin(db, venture_id: uuid.UUID) -> uuid.UUID:
    org = await venture_org(db, venture_id)
    if not (await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only the business's admins can do this")
    return org


def _today() -> date:
    return datetime.now(UTC).astimezone(IST).date()


# ----------------------------------------------------------------------------- profile --
class TradeProfile(BaseModel):
    roles: list[Role] = Field(default_factory=lambda: ["exporter"], min_length=1, max_length=3)
    legal_name: str = Field(min_length=1, max_length=160)
    address: str = Field(min_length=5, max_length=400)
    iec: str | None = Field(default=None, description="Importer-Exporter Code, 10 characters")
    gstin: str | None = None
    ad_code: str | None = Field(default=None, description="the bank's Authorised Dealer code")
    bank_details: str | None = Field(default=None, max_length=600)
    lut_arn: str | None = Field(default=None, max_length=30)
    lut_valid_until: date | None = None
    cha_licence: str | None = Field(default=None, max_length=40)
    email: str | None = Field(default=None, max_length=254)
    phone: str | None = Field(default=None, max_length=24)
    default_currency: str = Field(default="USD", pattern=r"^[A-Z]{3}$")
    realisation_months: int = Field(default=9, ge=1, le=36,
                                    description="months to realise export proceeds (RBI; 9 unless the rule changes)")
    prefix_export: str = Field(default="EXP", pattern=r"^[A-Z0-9]{1,5}$")
    prefix_import: str = Field(default="IMP", pattern=r"^[A-Z0-9]{1,5}$")
    prefix_job: str = Field(default="JOB", pattern=r"^[A-Z0-9]{1,5}$")
    declaration: str | None = Field(default=None, max_length=600)

    _e = field_validator("email")(lambda v: _email(v))
    _u = field_validator("iec", "gstin", "lut_arn")(lambda v: _upper(v))

    @field_validator("iec")
    @classmethod
    def _iec(cls, v: str | None) -> str | None:
        if v and not re.fullmatch(r"[0-9A-Z]{10}", v):
            raise ValueError("an IEC is 10 letters or digits")
        return v

    @field_validator("gstin")
    @classmethod
    def _gstin(cls, v: str | None) -> str | None:
        if v and not re.fullmatch(r"[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]", v):
            raise ValueError("that GSTIN doesn't look right")
        return v

    @field_validator("ad_code")
    @classmethod
    def _ad(cls, v: str | None) -> str | None:
        v = (v or "").replace(" ", "") or None
        if v and not re.fullmatch(r"[0-9]{7,14}", v):
            raise ValueError("an AD code is 7 to 14 digits")
        return v


class TradeProfileOut(TradeProfile):
    configured: bool
    can_edit: bool


PROFILE_COLS = ("roles, legal_name, address, iec, gstin, ad_code, bank_details, lut_arn, lut_valid_until, cha_licence,"
                " email, phone, default_currency, realisation_months, prefix_export, prefix_import, prefix_job, declaration")


async def _profile(db, venture_id: uuid.UUID):
    return (await db.execute(text(f"SELECT {PROFILE_COLS} FROM trade_profiles WHERE venture_id = :v"),
                             {"v": venture_id})).first()


@router.get("/ventures/{venture_id}/trade-profile", response_model=TradeProfileOut)
async def get_profile(venture_id: uuid.UUID, db: TenantDB) -> TradeProfileOut:
    await venture_org(db, venture_id)
    admin = bool((await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar())
    r = await _profile(db, venture_id)
    if r is None:
        name = (await db.execute(text("SELECT name FROM ventures WHERE id = :v"), {"v": venture_id})).scalar() or "Business"
        return TradeProfileOut(configured=False, can_edit=admin, legal_name=name, address="Not set yet")
    return TradeProfileOut(configured=True, can_edit=admin, **r._mapping)


@router.put("/ventures/{venture_id}/trade-profile", response_model=TradeProfileOut)
async def put_profile(venture_id: uuid.UUID, body: TradeProfile, user_id: UserId, db: TenantDB) -> TradeProfileOut:
    org = await _admin(db, venture_id)
    p = body.model_dump()
    p["roles"] = sorted(set(p["roles"]), key=["exporter", "importer", "cha"].index)
    cols = [c.strip() for c in PROFILE_COLS.split(",")]
    await db.execute(text(
        f"INSERT INTO trade_profiles (venture_id, org_id, {PROFILE_COLS}, updated_by, updated_at)"
        f" VALUES (:v, :o, {', '.join(':' + c for c in cols)}, :u, now())"
        f" ON CONFLICT (venture_id) DO UPDATE SET {', '.join(f'{c} = EXCLUDED.{c}' for c in cols)},"
        " updated_by = EXCLUDED.updated_by, updated_at = now()"),
        {**p, "v": venture_id, "o": org, "u": user_id})
    return await get_profile(venture_id, db)


# --------------------------------------------------------------------------- shipments --
class ShipmentFields(BaseModel):
    party_name: str | None = Field(default=None, min_length=1, max_length=160)
    party_country: str | None = Field(default=None, description="ISO 3166 two letters, e.g. AE")
    party_email: str | None = Field(default=None, max_length=254)
    party_phone: str | None = Field(default=None, max_length=24)
    party_address: str | None = Field(default=None, max_length=400)
    other_party: str | None = Field(default=None, max_length=300)
    reference: str | None = Field(default=None, max_length=80)
    incoterm: Incoterm | None = None
    incoterm_place: str | None = Field(default=None, max_length=80)
    mode: Mode | None = None
    port_loading: str | None = Field(default=None, max_length=80)
    port_discharge: str | None = Field(default=None, max_length=80)
    final_destination: str | None = Field(default=None, max_length=80)
    carrier: str | None = Field(default=None, max_length=80)
    vessel: str | None = Field(default=None, max_length=80)
    booking_no: str | None = Field(default=None, max_length=40)
    containers: str | None = Field(default=None, max_length=400)
    bl_no: str | None = Field(default=None, max_length=40)
    bl_date: date | None = None
    customs_no: str | None = Field(default=None, max_length=40)
    customs_date: date | None = None
    cutoff_at: datetime | None = None
    etd: date | None = None
    eta: date | None = None
    shipped_on: date | None = None
    arrived_on: date | None = None
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    value_minor: int | None = Field(default=None, ge=0, le=MAX_MINOR)
    freight_minor: int | None = Field(default=None, ge=0, le=MAX_MINOR)
    insurance_minor: int | None = Field(default=None, ge=0, le=MAX_MINOR)
    payment_terms: Terms | None = None
    payment_days: int | None = Field(default=None, ge=0, le=365)
    lc_no: str | None = Field(default=None, max_length=40)
    lc_expiry: date | None = None
    lc_last_shipment: date | None = None
    received_minor: int | None = Field(default=None, ge=0, le=MAX_MINOR)
    realise_by: date | None = None
    realised_on: date | None = None
    brc_no: str | None = Field(default=None, max_length=40)
    duty_paise: int | None = Field(default=None, ge=0, le=MAX_MINOR)
    fee_paise: int | None = Field(default=None, ge=0, le=MAX_MINOR)
    reimbursable_paise: int | None = Field(default=None, ge=0, le=MAX_MINOR)
    lut: bool | None = None
    notes: str | None = Field(default=None, max_length=4000)

    _e = field_validator("party_email")(lambda v: _email(v))

    @field_validator("party_country")
    @classmethod
    def _country(cls, v: str | None) -> str | None:
        v = _upper(v)
        if v and not re.fullmatch(r"[A-Z]{2}", v):
            raise ValueError("use the two-letter country code, e.g. AE, US, DE")
        return v


class ShipmentIn(ShipmentFields):
    direction: Direction
    for_client: bool = Field(default=False, description="a C&F agent's job for a client")
    party_name: str = Field(min_length=1, max_length=160)
    number: str | None = Field(default=None, max_length=30, description="leave out to number it automatically")
    stage: Stage | None = None


class ShipmentPatch(ShipmentFields):
    number: str | None = Field(default=None, min_length=1, max_length=30)
    stage: Stage | None = None


class Item(BaseModel):
    description: str = Field(min_length=1, max_length=300)
    hs_code: str | None = Field(default=None, pattern=r"^[0-9]{4,10}$")
    qty: Decimal = Field(gt=0, le=Decimal("1e10"))
    unit: str | None = Field(default=None, max_length=12)
    unit_price_minor: int = Field(ge=0, le=MAX_MINOR)


class ItemOut(Item):
    amount_minor: int


class Package(BaseModel):
    marks: str | None = Field(default=None, max_length=120)
    kind: str = Field(min_length=1, max_length=30)
    count: int = Field(ge=1, le=1_000_000)
    contents: str | None = Field(default=None, max_length=300)
    net_kg: Decimal | None = Field(default=None, ge=0, le=Decimal("1e9"))
    gross_kg: Decimal | None = Field(default=None, ge=0, le=Decimal("1e9"))
    dimensions: str | None = Field(default=None, max_length=60)


class DocOut(BaseModel):
    id: uuid.UUID
    code: str
    name: str
    needed_by: str | None
    status: Literal["needed", "received", "done", "not_needed"]
    ref_no: str | None
    ref_date: date | None
    note: str | None
    document_id: uuid.UUID | None


class DocIn(BaseModel):
    code: str | None = Field(default=None, pattern=r"^[a-z0-9_]{1,40}$", description="one of the extras, or leave out")
    name: str | None = Field(default=None, min_length=1, max_length=80)
    needed_by: Stage | None = None


class DocPatch(BaseModel):
    status: Literal["needed", "received", "done", "not_needed"] | None = None
    ref_no: str | None = Field(default=None, max_length=60)
    ref_date: date | None = None
    note: str | None = Field(default=None, max_length=300)
    document_id: uuid.UUID | None = None
    name: str | None = Field(default=None, min_length=1, max_length=80)


class EventOut(BaseModel):
    kind: str
    text: str
    stage: str | None
    by: str | None
    at: datetime


class AlertOut(BaseModel):
    level: Literal["urgent", "soon", "info"]
    kind: str
    text: str


class StageOut(BaseModel):
    code: str
    label: str


class ShipmentRow(BaseModel):
    id: uuid.UUID
    number: str
    direction: Direction
    for_client: bool
    stage: str
    stage_label: str
    party_name: str
    party_country: str | None
    reference: str | None
    mode: str
    incoterm: str | None
    port_loading: str | None
    port_discharge: str | None
    etd: date | None
    eta: date | None
    cutoff_at: datetime | None
    currency: str
    value_minor: int
    received_minor: int
    docs_needed: int
    docs_total: int
    alerts: list[AlertOut]
    updated_at: datetime


class ShipmentOut(ShipmentRow):
    party_email: str | None
    party_phone: str | None
    party_address: str | None
    other_party: str | None
    incoterm_place: str | None
    final_destination: str | None
    carrier: str | None
    vessel: str | None
    booking_no: str | None
    containers: str | None
    bl_no: str | None
    bl_date: date | None
    customs_no: str | None
    customs_date: date | None
    shipped_on: date | None
    arrived_on: date | None
    freight_minor: int
    insurance_minor: int
    payment_terms: str | None
    payment_days: int | None
    lc_no: str | None
    lc_expiry: date | None
    lc_last_shipment: date | None
    realise_by: date | None
    realised_on: date | None
    brc_no: str | None
    duty_paise: int | None
    fee_paise: int | None
    reimbursable_paise: int | None
    invoice_id: uuid.UUID | None
    lut: bool
    notes: str | None
    last_update_at: datetime | None
    stages: list[StageOut]
    items: list[ItemOut]
    packages: list[Package]
    docs: list[DocOut]
    events: list[EventOut]
    extra_docs: list[StageOut] = Field(description="documents that can be added to the checklist (code, name)")
    can_edit: bool


class Attention(BaseModel):
    shipment_id: uuid.UUID
    number: str
    party_name: str
    level: Literal["urgent", "soon", "info"]
    text: str


class ShipmentsOut(BaseModel):
    items: list[ShipmentRow]
    attention: list[Attention]
    profile_alert: AlertOut | None
    profile_configured: bool
    roles: list[str]
    can_edit: bool


async def _docs(db, ids: list[uuid.UUID]) -> dict[uuid.UUID, list]:
    out: dict[uuid.UUID, list] = {i: [] for i in ids}
    if not ids:
        return out
    for d in (await db.execute(text("SELECT * FROM shipment_docs WHERE shipment_id = ANY (:ids) ORDER BY position, name"),
                               {"ids": ids})).all():
        out[d.shipment_id].append(d)
    return out


def _row(s, docs: list, today: date) -> ShipmentRow:
    return ShipmentRow(
        id=s.id, number=s.number, direction=s.direction, for_client=s.for_client, stage=s.stage,
        stage_label=tr.stage_label(s.direction, s.stage), party_name=s.party_name, party_country=s.party_country,
        reference=s.reference, mode=s.mode, incoterm=s.incoterm, port_loading=s.port_loading,
        port_discharge=s.port_discharge, etd=s.etd, eta=s.eta, cutoff_at=s.cutoff_at, currency=s.currency,
        value_minor=s.value_minor, received_minor=s.received_minor,
        docs_needed=sum(1 for d in docs if d.status == "needed"),
        docs_total=sum(1 for d in docs if d.status != "not_needed"),
        alerts=[AlertOut(level=a.level, kind=a.kind, text=a.text) for a in tr.alerts(s, docs, today)],
        updated_at=s.updated_at)


@router.get("/ventures/{venture_id}/shipments", response_model=ShipmentsOut)
async def list_shipments(venture_id: uuid.UUID, db: TenantDB,
                         show: Literal["open", "closed", "all"] = Query(default="open"),
                         q: str | None = Query(default=None, max_length=80)) -> ShipmentsOut:
    await venture_org(db, venture_id)
    where = {"open": " AND stage NOT IN ('closed', 'cancelled')", "closed": " AND stage IN ('closed', 'cancelled')",
             "all": ""}[show]
    p: dict = {"v": venture_id}
    if q and q.strip():
        where += (" AND (number ILIKE :q OR party_name ILIKE :q OR coalesce(reference, '') ILIKE :q"
                  " OR coalesce(bl_no, '') ILIKE :q OR coalesce(containers, '') ILIKE :q OR coalesce(customs_no, '') ILIKE :q)")
        p["q"] = f"%{q.strip()}%"
    rows = (await db.execute(text(f"SELECT * FROM shipments WHERE venture_id = :v{where}"
                                  " ORDER BY updated_at DESC LIMIT 300"), p)).all()
    docs = await _docs(db, [r.id for r in rows])
    today = _today()
    items = [_row(r, docs[r.id], today) for r in rows]
    att = [Attention(shipment_id=i.id, number=i.number, party_name=i.party_name, level=a.level, text=a.text)
           for i in items for a in i.alerts]
    att.sort(key=lambda a: {"urgent": 0, "soon": 1, "info": 2}[a.level])
    prof = await _profile(db, venture_id)
    la = tr.lut_alert(prof, today)
    can = bool((await db.execute(text("SELECT :v = ANY (private.writable_ventures())"), {"v": venture_id})).scalar())
    return ShipmentsOut(items=items, attention=att, profile_alert=AlertOut(level=la.level, kind=la.kind, text=la.text) if la else None,
                        profile_configured=prof is not None, roles=list(prof.roles) if prof else [], can_edit=can)


async def _shipment(db, venture_id: uuid.UUID, shipment_id: uuid.UUID):
    await venture_org(db, venture_id)
    s = (await db.execute(text("SELECT * FROM shipments WHERE id = :s AND venture_id = :v"),
                          {"s": shipment_id, "v": venture_id})).first()
    if s is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "shipment not found")
    return s


async def _out(db, venture_id: uuid.UUID, shipment_id: uuid.UUID) -> ShipmentOut:
    s = await _shipment(db, venture_id, shipment_id)
    docs = (await _docs(db, [s.id]))[s.id]
    items = (await db.execute(text("SELECT * FROM shipment_items WHERE shipment_id = :s ORDER BY position"),
                              {"s": s.id})).all()
    packs = (await db.execute(text("SELECT * FROM shipment_packages WHERE shipment_id = :s ORDER BY position"),
                              {"s": s.id})).all()
    events = (await db.execute(text(
        "SELECT e.kind, e.text, e.stage, e.at, u.full_name, u.email FROM shipment_events e"
        " LEFT JOIN users u ON u.id = e.by_user WHERE e.shipment_id = :s ORDER BY e.at DESC LIMIT 100"),
        {"s": s.id})).all()
    can = bool((await db.execute(text("SELECT :v = ANY (private.writable_ventures())"), {"v": venture_id})).scalar())
    base = _row(s, docs, _today()).model_dump()
    taken = {d.code for d in docs}
    return ShipmentOut(
        **base, party_email=s.party_email, party_phone=s.party_phone, party_address=s.party_address,
        other_party=s.other_party, incoterm_place=s.incoterm_place, final_destination=s.final_destination,
        carrier=s.carrier, vessel=s.vessel, booking_no=s.booking_no, containers=s.containers, bl_no=s.bl_no,
        bl_date=s.bl_date, customs_no=s.customs_no, customs_date=s.customs_date, shipped_on=s.shipped_on,
        arrived_on=s.arrived_on, freight_minor=s.freight_minor, insurance_minor=s.insurance_minor,
        payment_terms=s.payment_terms, payment_days=s.payment_days, lc_no=s.lc_no, lc_expiry=s.lc_expiry,
        lc_last_shipment=s.lc_last_shipment, realise_by=s.realise_by, realised_on=s.realised_on, brc_no=s.brc_no,
        duty_paise=s.duty_paise, fee_paise=s.fee_paise, reimbursable_paise=s.reimbursable_paise,
        invoice_id=s.invoice_id, lut=s.lut, notes=s.notes, last_update_at=s.last_update_at,
        stages=[StageOut(code=c, label=tr.stage_label(s.direction, c))
                for c in (*tr.stages(s.direction, s.for_client), "cancelled")],
        items=[ItemOut(description=i.description, hs_code=i.hs_code, qty=i.qty, unit=i.unit,
                       unit_price_minor=i.unit_price_minor, amount_minor=i.amount_minor) for i in items],
        packages=[Package(marks=p.marks, kind=p.kind, count=p.count, contents=p.contents, net_kg=p.net_kg,
                          gross_kg=p.gross_kg, dimensions=p.dimensions) for p in packs],
        docs=[DocOut(id=d.id, code=d.code, name=d.name, needed_by=d.needed_by, status=d.status, ref_no=d.ref_no,
                     ref_date=d.ref_date, note=d.note, document_id=d.document_id) for d in docs],
        events=[EventOut(kind=e.kind, text=e.text, stage=e.stage, by=e.full_name or e.email, at=e.at) for e in events],
        extra_docs=[StageOut(code=c, label=n) for c, n in tr.EXTRA_DOCS if c not in taken],
        can_edit=can)


async def _event(db, s, kind: str, msg: str, user_id: uuid.UUID | None, stage: str | None = None) -> None:
    await db.execute(text("INSERT INTO shipment_events (org_id, venture_id, shipment_id, kind, text, stage, by_user)"
                          " VALUES (:o, :v, :s, :k, :t, :st, :u)"),
                     {"o": s.org_id, "v": s.venture_id, "s": s.id, "k": kind, "t": msg[:1000], "st": stage, "u": user_id})


@router.post("/ventures/{venture_id}/shipments", response_model=ShipmentOut, status_code=201)
async def create_shipment(venture_id: uuid.UUID, body: ShipmentIn, user_id: UserId, db: TenantDB) -> ShipmentOut:
    org = await _writer(db, venture_id)
    prof = await _profile(db, venture_id)
    flow = tr.stages(body.direction, body.for_client)
    stage = body.stage or flow[0]
    if stage not in flow and stage != "cancelled":
        raise HTTPException(422, f"'{stage}' isn't a stage of this kind of file")
    num = (body.number or "").strip()
    if not num:
        kind = tr.series_kind(body.direction, body.for_client)
        prefix = getattr(prof, f"prefix_{kind}", None) if prof else None
        prefix = prefix or {"export": "EXP", "import": "IMP", "job": "JOB"}[kind]
        fy = tr.fy_now(_today())
        n = (await db.execute(text(
            "INSERT INTO trade_series (org_id, venture_id, kind, fy, last_no) VALUES (:o, :v, :k, :f, 1)"
            " ON CONFLICT (venture_id, kind, fy) DO UPDATE SET last_no = trade_series.last_no + 1 RETURNING last_no"),
            {"o": org, "v": venture_id, "k": kind, "f": fy})).scalar()
        num = tr.number(prefix, fy, n)
    f = body.model_dump(exclude={"direction", "for_client", "number", "stage"}, exclude_none=True)
    f.setdefault("currency", (prof.default_currency if prof else None) or ("INR" if body.for_client else "USD"))
    if body.direction == "export" and not body.for_client and "realise_by" not in f and body.shipped_on:
        f["realise_by"] = tr.add_months(body.shipped_on, prof.realisation_months if prof else 9)
    cols = ["org_id", "venture_id", "number", "direction", "for_client", "stage", "created_by", *f.keys()]
    params = {"org_id": org, "venture_id": venture_id, "number": num, "direction": body.direction,
              "for_client": body.for_client, "stage": stage, "created_by": user_id, **f}
    try:
        async with db.begin_nested():
            sid = (await db.execute(text(f"INSERT INTO shipments ({', '.join(cols)}) VALUES ({', '.join(':' + c for c in cols)})"
                                         " RETURNING id"), params)).scalar()
    except DBAPIError as exc:
        if "shipments_venture_id_number_key" in str(exc):
            raise HTTPException(status.HTTP_409_CONFLICT, f"a file numbered {num} already exists") from None
        raise_for_db(exc, "venture not found")
        raise
    for pos, (code, name, needed) in enumerate(tr.doc_template(body.direction, body.for_client, body.incoterm,
                                                                body.payment_terms), start=1):
        await db.execute(text("INSERT INTO shipment_docs (org_id, venture_id, shipment_id, code, name, needed_by, position)"
                              " VALUES (:o, :v, :s, :c, :n, :nb, :p)"),
                         {"o": org, "v": venture_id, "s": sid, "c": code, "n": name, "nb": needed, "p": pos})
    s = await _shipment(db, venture_id, sid)
    await _event(db, s, "created", f"File opened: {tr.stage_label(s.direction, stage)}", user_id, stage)
    return await _out(db, venture_id, sid)


@router.get("/ventures/{venture_id}/shipments/{shipment_id}", response_model=ShipmentOut)
async def get_shipment(venture_id: uuid.UUID, shipment_id: uuid.UUID, db: TenantDB) -> ShipmentOut:
    return await _out(db, venture_id, shipment_id)


@router.patch("/ventures/{venture_id}/shipments/{shipment_id}", response_model=ShipmentOut)
async def update_shipment(venture_id: uuid.UUID, shipment_id: uuid.UUID, body: ShipmentPatch, user_id: UserId,
                          db: TenantDB) -> ShipmentOut:
    await _writer(db, venture_id)
    s = await _shipment(db, venture_id, shipment_id)
    f = body.model_dump(exclude_unset=True)
    for k in ("party_name", "currency", "mode", "number", "stage"):
        if k in f and f[k] is None:
            raise HTTPException(422, f"{k.replace('_', ' ')} can't be empty")
    for k in ("value_minor", "freight_minor", "insurance_minor", "received_minor"):
        if k in f and f[k] is None:
            f[k] = 0
    if "lut" in f and f["lut"] is None:
        f.pop("lut")
    stage = f.get("stage")
    if stage and stage != s.stage:
        if stage not in tr.stages(s.direction, s.for_client) and stage not in ("cancelled",):
            raise HTTPException(422, f"'{stage}' isn't a stage of this kind of file")
        today = _today()
        if stage == "shipped" and not (f.get("shipped_on") or s.shipped_on):
            f["shipped_on"] = today
        if stage == "arrived" and not (f.get("arrived_on") or s.arrived_on):
            f["arrived_on"] = today
        if stage == "paid" and s.direction == "export" and not s.for_client and not (f.get("realised_on") or s.realised_on):
            f["realised_on"] = today
    shipped_on = f.get("shipped_on", s.shipped_on)
    if (s.direction == "export" and not s.for_client and shipped_on and "realise_by" not in f
            and (s.realise_by is None or ("shipped_on" in f and f["shipped_on"] != s.shipped_on))):
        prof = await _profile(db, venture_id)
        f["realise_by"] = tr.add_months(shipped_on, prof.realisation_months if prof else 9)
    if f:
        sets = ", ".join(f"{k} = :{k}" for k in f)
        try:
            async with db.begin_nested():
                await db.execute(text(f"UPDATE shipments SET {sets}, updated_at = now() WHERE id = :id AND venture_id = :v"),
                                 {**f, "id": s.id, "v": venture_id})
        except DBAPIError as exc:
            if "shipments_venture_id_number_key" in str(exc):
                raise HTTPException(status.HTTP_409_CONFLICT, "another file already has that number") from None
            raise_for_db(exc, "shipment not found")
            raise
    if stage and stage != s.stage:
        await _event(db, s, "stage", tr.stage_label(s.direction, stage), user_id, stage)
    if "received_minor" in f and f["received_minor"] != s.received_minor:
        verb = "Paid to supplier" if s.direction == "import" else "Received"
        await _event(db, s, "payment", f"{verb}: {tr.money(f['received_minor'], f.get('currency') or s.currency)} in all",
                     user_id)
    return await _out(db, venture_id, shipment_id)


@router.delete("/ventures/{venture_id}/shipments/{shipment_id}", status_code=204)
async def delete_shipment(venture_id: uuid.UUID, shipment_id: uuid.UUID, db: TenantDB) -> None:
    await _admin(db, venture_id)
    await _shipment(db, venture_id, shipment_id)
    await db.execute(text("DELETE FROM shipments WHERE id = :s AND venture_id = :v"), {"s": shipment_id, "v": venture_id})


@router.put("/ventures/{venture_id}/shipments/{shipment_id}/items", response_model=ShipmentOut)
async def put_items(venture_id: uuid.UUID, shipment_id: uuid.UUID, body: list[Item], db: TenantDB) -> ShipmentOut:
    await _writer(db, venture_id)
    s = await _shipment(db, venture_id, shipment_id)
    if len(body) > 200:
        raise HTTPException(422, "at most 200 lines")
    await db.execute(text("DELETE FROM shipment_items WHERE shipment_id = :s"), {"s": s.id})
    total = 0
    for pos, it in enumerate(body, start=1):
        amt = tr.line_amount(it.qty, it.unit_price_minor)
        total += amt
        await db.execute(text(
            "INSERT INTO shipment_items (org_id, venture_id, shipment_id, position, description, hs_code, qty, unit,"
            " unit_price_minor, amount_minor) VALUES (:o, :v, :s, :p, :d, :h, :q, :u, :r, :a)"),
            {"o": s.org_id, "v": s.venture_id, "s": s.id, "p": pos, "d": it.description.strip(), "h": it.hs_code,
             "q": it.qty, "u": (it.unit or "").strip() or None, "r": it.unit_price_minor, "a": amt})
    if body:
        if total > MAX_MINOR:
            raise HTTPException(422, "the total is too large")
        await db.execute(text("UPDATE shipments SET value_minor = :t, updated_at = now() WHERE id = :s"), {"t": total, "s": s.id})
    return await _out(db, venture_id, shipment_id)


@router.put("/ventures/{venture_id}/shipments/{shipment_id}/packages", response_model=ShipmentOut)
async def put_packages(venture_id: uuid.UUID, shipment_id: uuid.UUID, body: list[Package], db: TenantDB) -> ShipmentOut:
    await _writer(db, venture_id)
    s = await _shipment(db, venture_id, shipment_id)
    if len(body) > 200:
        raise HTTPException(422, "at most 200 rows")
    await db.execute(text("DELETE FROM shipment_packages WHERE shipment_id = :s"), {"s": s.id})
    for pos, p in enumerate(body, start=1):
        await db.execute(text(
            "INSERT INTO shipment_packages (org_id, venture_id, shipment_id, position, marks, kind, count, contents,"
            " net_kg, gross_kg, dimensions) VALUES (:o, :v, :s, :p, :m, :k, :c, :ct, :n, :g, :d)"),
            {"o": s.org_id, "v": s.venture_id, "s": s.id, "p": pos, "m": p.marks, "k": p.kind.strip(), "c": p.count,
             "ct": p.contents, "n": p.net_kg, "g": p.gross_kg, "d": p.dimensions})
    await db.execute(text("UPDATE shipments SET updated_at = now() WHERE id = :s"), {"s": s.id})
    return await _out(db, venture_id, shipment_id)


@router.post("/ventures/{venture_id}/shipments/{shipment_id}/docs", response_model=ShipmentOut, status_code=201)
async def add_doc(venture_id: uuid.UUID, shipment_id: uuid.UUID, body: DocIn, db: TenantDB) -> ShipmentOut:
    await _writer(db, venture_id)
    s = await _shipment(db, venture_id, shipment_id)
    extras = dict(tr.EXTRA_DOCS)
    if body.code and body.code in extras:
        code, name = body.code, body.name or extras[body.code]
    elif body.name:
        code, name = "custom_" + uuid.uuid4().hex[:8], body.name.strip()
    else:
        raise HTTPException(422, "choose a document or type its name")
    pos = (await db.execute(text("SELECT coalesce(max(position), 0) + 1 FROM shipment_docs WHERE shipment_id = :s"),
                            {"s": s.id})).scalar()
    try:
        async with db.begin_nested():
            await db.execute(text(
                "INSERT INTO shipment_docs (org_id, venture_id, shipment_id, code, name, needed_by, position)"
                " VALUES (:o, :v, :s, :c, :n, :nb, :p)"),
                {"o": s.org_id, "v": s.venture_id, "s": s.id, "c": code, "n": name, "nb": body.needed_by, "p": pos})
    except DBAPIError as exc:
        if "shipment_docs_shipment_id_code_key" in str(exc):
            raise HTTPException(status.HTTP_409_CONFLICT, "that document is already on the list") from None
        raise_for_db(exc, "shipment not found")
        raise
    return await _out(db, venture_id, shipment_id)


@router.patch("/ventures/{venture_id}/shipments/{shipment_id}/docs/{doc_id}", response_model=ShipmentOut)
async def update_doc(venture_id: uuid.UUID, shipment_id: uuid.UUID, doc_id: uuid.UUID, body: DocPatch, user_id: UserId,
                     db: TenantDB) -> ShipmentOut:
    await _writer(db, venture_id)
    s = await _shipment(db, venture_id, shipment_id)
    d = (await db.execute(text("SELECT * FROM shipment_docs WHERE id = :d AND shipment_id = :s"),
                          {"d": doc_id, "s": s.id})).first()
    if d is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "document not found")
    f = body.model_dump(exclude_unset=True)
    if "status" in f and f["status"] is None:
        f.pop("status")
    if f.get("document_id") is not None:
        ok = (await db.execute(text("SELECT 1 FROM documents WHERE id = :d AND venture_id = :v"),
                               {"d": f["document_id"], "v": venture_id})).first()
        if ok is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "file not found")
        if "status" not in f and d.status == "needed":
            f["status"] = "received"
    if f:
        await db.execute(text(f"UPDATE shipment_docs SET {', '.join(f'{k} = :{k}' for k in f)}, updated_at = now()"
                              " WHERE id = :d"), {**f, "d": d.id})
        await db.execute(text("UPDATE shipments SET updated_at = now() WHERE id = :s"), {"s": s.id})
        if f.get("status") and f["status"] != d.status:
            await _event(db, s, "document", f"{f.get('name') or d.name}: {f['status'].replace('_', ' ')}", user_id)
    return await _out(db, venture_id, shipment_id)


@router.delete("/ventures/{venture_id}/shipments/{shipment_id}/docs/{doc_id}", response_model=ShipmentOut)
async def delete_doc(venture_id: uuid.UUID, shipment_id: uuid.UUID, doc_id: uuid.UUID, db: TenantDB) -> ShipmentOut:
    await _writer(db, venture_id)
    s = await _shipment(db, venture_id, shipment_id)
    await db.execute(text("DELETE FROM shipment_docs WHERE id = :d AND shipment_id = :s"), {"d": doc_id, "s": s.id})
    return await _out(db, venture_id, shipment_id)


class NoteIn(BaseModel):
    text: str = Field(min_length=1, max_length=1000)


@router.post("/ventures/{venture_id}/shipments/{shipment_id}/notes", response_model=ShipmentOut, status_code=201)
async def add_note(venture_id: uuid.UUID, shipment_id: uuid.UUID, body: NoteIn, user_id: UserId, db: TenantDB) -> ShipmentOut:
    await _writer(db, venture_id)
    s = await _shipment(db, venture_id, shipment_id)
    await _event(db, s, "note", body.text.strip(), user_id)
    await db.execute(text("UPDATE shipments SET updated_at = now() WHERE id = :s"), {"s": s.id})
    return await _out(db, venture_id, shipment_id)


class UpdateIn(BaseModel):
    channel: Literal["email", "whatsapp"] = "email"
    note: str = Field(default="", max_length=400, description="a line to add, e.g. 'Original documents couriered today'")


class StartedOut(BaseModel):
    run_id: uuid.UUID


@router.post("/ventures/{venture_id}/shipments/{shipment_id}/update", response_model=StartedOut, status_code=201)
async def send_update(venture_id: uuid.UUID, shipment_id: uuid.UUID, body: UpdateIn, user_id: UserId, db: TenantDB,
                      svc: Svc) -> StartedOut:
    from kritvia_api.engine.runner import start_run
    from kritvia_api.services.quota import PlanRestricted
    await _writer(db, venture_id)
    s = await _shipment(db, venture_id, shipment_id)
    if body.channel == "email" and not s.party_email:
        raise HTTPException(422, "add the party's email address first")
    if body.channel == "whatsapp" and not s.party_phone:
        raise HTTPException(422, "add the party's phone number first")
    try:
        rid = await start_run(svc, actor_user_id=user_id, actor_type="user", venture_id=venture_id, workflow="trade_update",
                              input={"shipment_id": str(s.id), "channel": body.channel, "note": body.note.strip()},
                              trigger_kind="manual", title=f"Update on {s.number}")
    except PlanRestricted as exc:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, str(exc)) from None
    return StartedOut(run_id=rid)


class BillOut(BaseModel):
    invoice_id: uuid.UUID
    number: str
    amount_paise: int


@router.post("/ventures/{venture_id}/shipments/{shipment_id}/bill", response_model=BillOut, status_code=201)
async def bill_job(venture_id: uuid.UUID, shipment_id: uuid.UUID, user_id: UserId, db: TenantDB) -> BillOut:
    await _writer(db, venture_id)
    s = await _shipment(db, venture_id, shipment_id)
    if not s.for_client:
        raise HTTPException(422, "only a C&F job is billed to a client")
    if s.invoice_id is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "this job is already billed")
    fee, reimb = int(s.fee_paise or 0), int(s.reimbursable_paise or 0)
    if fee + reimb <= 0:
        raise HTTPException(422, "add the agency fee or the reimbursable costs first")
    from kritvia_api.workflows.collections import rupees
    today = _today()
    notes = (f"C&F job {s.number}" + (f" (your ref. {s.reference})" if s.reference else "")
             + f": agency fee {rupees(fee)}; reimbursable costs {rupees(reimb)}"
             + (f"; BL/AWB {s.bl_no}" if s.bl_no else "") + (f"; {'SB' if s.direction == 'export' else 'BE'} {s.customs_no}" if s.customs_no else ""))
    inv = (await db.execute(text(
        "INSERT INTO invoices (org_id, venture_id, number, customer_name, customer_email, customer_phone, amount_paise,"
        " issued_on, due_on, notes, source, created_by)"
        " VALUES (:o, :v, :n, :c, :e, :p, :a, :i, :d, :notes, 'manual', :u) RETURNING id"),
        {"o": s.org_id, "v": venture_id, "n": s.number, "c": s.party_name, "e": s.party_email, "p": s.party_phone,
         "a": fee + reimb, "i": today, "d": today + timedelta(days=15), "notes": notes[:1000], "u": user_id})).scalar()
    await db.execute(text("UPDATE shipments SET invoice_id = :i, updated_at = now() WHERE id = :s"), {"i": inv, "s": s.id})
    await _event(db, s, "payment", f"Billed {rupees(fee + reimb)} (invoice {s.number})", user_id)
    return BillOut(invoice_id=inv, number=s.number, amount_paise=fee + reimb)
