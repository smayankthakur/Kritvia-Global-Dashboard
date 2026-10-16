"""Partner programme for CAs and agencies.

Partners (Kritvia users approved by Kritvia's team) share a link with their code. A business that signs up
with it gets 10% off its first 3 months; the partner earns 20% of what that business pays for 12 months.

  GET   /partners/me                     the partner's own page: code, link, referred businesses, money
  POST  /partners/apply                  apply (Kritvia's team approves)
  PATCH /partners/me                     contact and payout details
  GET   /orgs/{org}/partner              whether an organisation came through a partner
  POST  /orgs/{org}/partner-code         an owner enters a partner's code (first 30 days, before paying)
  GET   /staff/partners                  Kritvia's team: applications, balances
  POST  /staff/partners/{id}/status      approve, pause or reject
  POST  /staff/partners/{id}/payout      record a payout of everything due (with the UPI/bank reference)
"""
from __future__ import annotations

import re
import secrets
import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.config import get_settings
from kritvia_api.deps import TenantDB, UserId
from kritvia_api.errors import raise_for_db
from kritvia_api.routers.first_win import is_staff
from kritvia_api.routers.invoices import phone_digits
from kritvia_api.services.payments import UPI_ID

router = APIRouter(tags=["partners"])
COMMISSION_PERCENT, COMMISSION_MONTHS, DISCOUNT_PERCENT, DISCOUNT_MONTHS = 20, 12, 10, 3


def _upi(v: str | None) -> str | None:
    v = (v or "").strip() or None
    if v and not UPI_ID.match(v):
        raise ValueError("that doesn't look like a UPI ID (name@bank)")
    return v


class PartnerDetails(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    firm: str | None = Field(default=None, max_length=160)
    city: str | None = Field(default=None, max_length=80)
    phone: str | None = Field(default=None, max_length=24)
    upi_id: str | None = Field(default=None, max_length=300, description="where payouts go")

    _u = field_validator("upi_id")(lambda v: _upi(v))
    _p = field_validator("phone")(lambda v: phone_digits(v))


class ApplyIn(PartnerDetails):
    kind: Literal["ca", "agency", "consultant", "other"]
    code: str | None = Field(default=None, max_length=12, description="the code you'd like (letters and digits)")


class PartnerOut(PartnerDetails):
    id: uuid.UUID
    kind: str
    code: str
    status: str
    link: str


class ReferredOrg(BaseModel):
    name: str
    plan: str
    referred_at: datetime
    commission_until: datetime
    earned_paise: int


class Commission(BaseModel):
    paid_paise: int
    commission_paise: int
    earned_at: datetime
    paid_out: bool


class Payout(BaseModel):
    amount_paise: int
    reference: str
    paid_at: datetime


class PartnerPage(BaseModel):
    partner: PartnerOut | None
    referrals: list[ReferredOrg]
    commissions: list[Commission]
    payouts: list[Payout]
    earned_paise: int
    paid_paise: int
    due_paise: int
    terms: str


TERMS = (f"Businesses that sign up with your link get {DISCOUNT_PERCENT}% off their first {DISCOUNT_MONTHS} months. You "
         f"earn {COMMISSION_PERCENT}% of what each of them pays Kritvia for {COMMISSION_MONTHS} months from sign-up, "
         "paid to your UPI ID after the payment clears. A business can be linked to one partner, in its first 30 days "
         "and before it first pays. You can't refer your own organisation.")


def _link(code: str) -> str:
    return f"{get_settings().public_web_url.rstrip('/')}/register?ref={code}"


def _partner(r) -> PartnerOut:
    return PartnerOut(id=r.id, name=r.name, firm=r.firm, city=r.city, phone=r.phone, upi_id=r.upi_id, kind=r.kind,
                      code=r.code, status=r.status, link=_link(r.code))


@router.get("/partners/me", response_model=PartnerPage)
async def me(db: TenantDB) -> PartnerPage:
    p = (await db.execute(text("SELECT * FROM partners"))).first()
    if p is None:
        return PartnerPage(partner=None, referrals=[], commissions=[], payouts=[], earned_paise=0, paid_paise=0,
                           due_paise=0, terms=TERMS)
    refs = (await db.execute(text("SELECT * FROM private.partner_orgs()"))).all()
    com = (await db.execute(text("SELECT paid_paise, commission_paise, earned_at, payout_id FROM partner_commissions"
                                 " ORDER BY earned_at DESC LIMIT 200"))).all()
    pay = (await db.execute(text("SELECT amount_paise, reference, paid_at FROM partner_payouts ORDER BY paid_at DESC"))).all()
    earned = sum(c.commission_paise for c in com)
    paid = sum(x.amount_paise for x in pay)
    return PartnerPage(
        partner=_partner(p),
        referrals=[ReferredOrg(name=r.name, plan=r.plan, referred_at=r.referred_at, commission_until=r.commission_until,
                               earned_paise=r.earned_paise) for r in refs],
        commissions=[Commission(paid_paise=c.paid_paise, commission_paise=c.commission_paise, earned_at=c.earned_at,
                                paid_out=c.payout_id is not None) for c in com],
        payouts=[Payout(amount_paise=x.amount_paise, reference=x.reference, paid_at=x.paid_at) for x in pay],
        earned_paise=earned, paid_paise=paid,
        due_paise=sum(c.commission_paise for c in com if c.payout_id is None), terms=TERMS)


def _make_code(name: str) -> str:
    base = re.sub(r"[^A-Z0-9]", "", name.upper())[:8] or "KV"
    return (base + secrets.token_hex(2).upper())[:12] if len(base) < 4 else base + str(secrets.randbelow(90) + 10)


@router.post("/partners/apply", response_model=PartnerOut, status_code=201)
async def apply(body: ApplyIn, user_id: UserId, db: TenantDB) -> PartnerOut:
    if (await db.execute(text("SELECT 1 FROM partners"))).first():
        raise HTTPException(status.HTTP_409_CONFLICT, "you have already applied")
    wanted = re.sub(r"[^A-Z0-9]", "", (body.code or "").upper())
    if body.code and not 4 <= len(wanted) <= 12:
        raise HTTPException(422, "a code is 4 to 12 letters or digits")
    for attempt in range(5):
        code = wanted if (wanted and attempt == 0) else _make_code(body.name)
        try:
            async with db.begin_nested():
                r = (await db.execute(text(
                    "INSERT INTO partners (user_id, code, name, firm, kind, city, phone, upi_id)"
                    " VALUES (:u, :c, :n, :f, :k, :ci, :p, :upi) RETURNING *"),
                    {"u": user_id, "c": code, "n": body.name.strip(), "f": (body.firm or "").strip() or None,
                     "k": body.kind, "ci": (body.city or "").strip() or None, "p": body.phone, "upi": body.upi_id})).first()
            return _partner(r)
        except DBAPIError as exc:
            if "partners_code_key" in str(exc):
                if wanted and attempt == 0:
                    raise HTTPException(status.HTTP_409_CONFLICT, "that code is taken; try another") from None
                continue
            raise_for_db(exc)
    raise HTTPException(status.HTTP_409_CONFLICT, "couldn't make a code; choose one yourself")


@router.patch("/partners/me", response_model=PartnerOut)
async def edit(body: PartnerDetails, db: TenantDB) -> PartnerOut:
    r = (await db.execute(text(
        "UPDATE partners SET name = :n, firm = :f, city = :c, phone = :p, upi_id = :u RETURNING *"),
        {"n": body.name.strip(), "f": (body.firm or "").strip() or None, "c": (body.city or "").strip() or None,
         "p": body.phone, "u": body.upi_id})).first()
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "you're not a partner yet")
    return _partner(r)


class OrgPartnerOut(BaseModel):
    partner: str | None = Field(description="the partner's name or firm, when the organisation came through one")
    discount: str | None


@router.get("/orgs/{org_id}/partner", response_model=OrgPartnerOut)
async def org_partner(org_id: uuid.UUID, db: TenantDB) -> OrgPartnerOut:
    name = (await db.execute(text("SELECT private.org_partner_name(:o)"), {"o": org_id})).scalar()
    if name is None:
        return OrgPartnerOut(partner=None, discount=None)
    return OrgPartnerOut(partner=name, discount=f"{DISCOUNT_PERCENT}% off your first {DISCOUNT_MONTHS} months")


class CodeIn(BaseModel):
    code: str = Field(min_length=4, max_length=20)


RESULT = {"unknown": (404, "that partner code doesn't exist (or isn't active yet)"),
          "own": (422, "you can't use your own partner code"),
          "already": (409, "this organisation already has a partner"),
          "too_late": (409, "a partner code can be added only in the first 30 days, before the first payment")}


@router.post("/orgs/{org_id}/partner-code", response_model=OrgPartnerOut)
async def use_code(org_id: uuid.UUID, body: CodeIn, db: TenantDB) -> OrgPartnerOut:
    try:
        async with db.begin_nested():
            res = (await db.execute(text("SELECT private.use_partner_code(:o, :c)"), {"o": org_id, "c": body.code})).scalar()
    except DBAPIError as exc:
        raise_for_db(exc, "organisation not found")
    if res != "ok":
        code, msg = RESULT.get(res, (422, "that code can't be used"))
        raise HTTPException(code, msg)
    return await org_partner(org_id, db)


# --------------------------------------------------------------- Kritvia's team --
class StaffPartner(BaseModel):
    id: uuid.UUID
    name: str
    firm: str | None
    kind: str
    city: str | None
    email: str
    phone: str | None
    upi_id: str | None
    code: str
    status: str
    created_at: datetime
    referrals: int
    earned_paise: int
    paid_paise: int
    due_paise: int


async def _staff(db, user_id: uuid.UUID) -> None:
    email = (await db.execute(text("SELECT email FROM users WHERE id = :u"), {"u": user_id})).scalar()
    if not is_staff(email):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not found")


@router.get("/staff/partners", response_model=list[StaffPartner])
async def staff_list(user_id: UserId, db: TenantDB) -> list[StaffPartner]:
    await _staff(db, user_id)
    rows = (await db.execute(text("SELECT * FROM private.staff_partners()"))).all()
    return [StaffPartner(**r._mapping, due_paise=r.earned_paise - r.paid_paise) for r in rows]


class StatusIn(BaseModel):
    status: Literal["active", "paused", "rejected"]


@router.post("/staff/partners/{partner_id}/status", response_model=list[StaffPartner])
async def staff_status(partner_id: uuid.UUID, body: StatusIn, user_id: UserId, db: TenantDB) -> list[StaffPartner]:
    await _staff(db, user_id)
    await db.execute(text("SELECT private.staff_set_partner_status(:p, :s)"), {"p": partner_id, "s": body.status})
    return await staff_list(user_id, db)


class PayoutIn(BaseModel):
    reference: str = Field(min_length=3, max_length=80, description="the UPI or bank transfer reference")


class PayoutOut(BaseModel):
    paid_paise: int


@router.post("/staff/partners/{partner_id}/payout", response_model=PayoutOut)
async def staff_payout(partner_id: uuid.UUID, body: PayoutIn, user_id: UserId, db: TenantDB) -> PayoutOut:
    await _staff(db, user_id)
    total = (await db.execute(text("SELECT private.staff_record_payout(:p, :r, :u)"),
                              {"p": partner_id, "r": body.reference.strip(), "u": user_id})).scalar()
    if not total:
        raise HTTPException(status.HTTP_409_CONFLICT, "nothing is due to this partner")
    return PayoutOut(paid_paise=total)
