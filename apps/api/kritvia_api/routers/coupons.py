"""Coupons (migrations 0049, 0065): free plan time, a percentage off a paid plan, extra trial days or extra AI
tokens, aimed at new or existing businesses, chosen industries, plans, or private lists of people.

  GET    /public/coupons/{code}            anyone: what the code gives and how many places are left
  GET    /orgs/{org_id}/coupon             members: the organisation's coupons
  POST   /orgs/{org_id}/coupon             owners: apply a code (one of each kind per organisation; once per person)
  GET    /staff/coupons                    Kritvia's team: every code, with who used it
  GET    /staff/coupons/options            Kritvia's team: kinds, plans, periods and industries to choose from
  POST   /staff/coupons                    Kritvia's team: create a code
  PUT    /staff/coupons/{code}             Kritvia's team: change it (the offer itself is fixed once used)
  PATCH  /staff/coupons/{code}             Kritvia's team: switch it off/on, change its places
  DELETE /staff/coupons/{code}             Kritvia's team: delete an unused code
  GET    /staff/coupons/{code}/uses.csv    Kritvia's team: who used it, as a spreadsheet

Free plan time and trial days never charge anything. A percentage off is a Razorpay offer attached to the
subscription when the business subscribes (billing.py); Razorpay applies it to the charges.
"""
from __future__ import annotations

import csv
import io
import json
import re
import uuid
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.deps import AnonDB, Svc, TenantDB, UserId
from kritvia_api.errors import raise_for_db
from kritvia_api.plans import plan as plan_of
from kritvia_api.ratelimit import client_ip, limiter
from kritvia_api.routers.partners import _staff

router = APIRouter(tags=["coupons"])
CODE = r"^[A-Za-z0-9][A-Za-z0-9-]{2,23}$"

Kind = Literal["free_plan", "percent_off", "trial_days", "ai_tokens"]
PaidPlan = Literal["starter", "growth", "scale"]
Period = Literal["monthly", "annual"]
Industry = Literal["agency", "loans", "kitchen", "trade", "retail", "clinic", "coaching", "freelancer", "other"]
Who = Literal["new", "unpaid", "anyone"]

KIND_NAMES = {"free_plan": "A plan free for a while", "percent_off": "A percentage off a paid plan",
              "trial_days": "Extra free-trial days", "ai_tokens": "Extra AI usage"}
INDUSTRY_NAMES = {"agency": "Agency or services", "loans": "Loans & real estate", "kitchen": "Restaurant or cloud kitchen",
                  "trade": "Exporter, importer or C&F agent", "retail": "Shop or e-commerce",
                  "clinic": "Clinic, salon or local services", "coaching": "Coaching or education",
                  "freelancer": "Freelancer or consultant", "other": "Something else"}
WHO_NAMES = {"new": "New businesses only", "unpaid": "Businesses not on a paid plan",
             "anyone": "Any business, paying ones too"}


def _plural(n: int, word: str) -> str:
    return f"{n:,} {word}{'' if n == 1 else 's'}"


def offer_words(kind: str, *, plan: str | None = None, months: int | None = None, days: int | None = None,
                percent: int | None = None, plans: list[str] | None = None, periods: list[str] | None = None,
                tokens: int | None = None) -> str:
    """What a coupon gives, in a sentence a customer reads: 'Scale plan free for 3 months'."""
    if kind == "free_plan":
        length = _plural(months, "month") if months else _plural(days or 0, "day")
        return f"{plan_of(plan or 'starter').name} plan free for {length}"
    if kind == "percent_off":
        which = (" or ".join(plan_of(p).name for p in plans) + " plan") if plans else "any plan"
        when = f" ({' or '.join(periods)} billing)" if periods and len(periods) == 1 else ""
        cycles = f" for the first {_plural(months, 'billing cycle')}" if months else ""
        return f"{percent}% off {which}{when}{cycles}"
    if kind == "trial_days":
        return f"{_plural(days or 0, 'extra day')} of free trial"
    return f"{tokens or 0:,} extra AI tokens a month for {_plural(months or 0, 'month')}"


def _words(r) -> str:
    return offer_words(r.kind, plan=r.plan, months=r.months, days=r.days, percent=r.percent,
                       plans=list(r.plans or []), periods=list(r.periods or []), tokens=r.tokens)


# ------------------------------------------------------------------------------------ public --
class CouponInfo(BaseModel):
    code: str
    kind: Kind
    plan: str | None
    plan_name: str | None
    months: int | None
    places_left: int
    open: bool
    offer: str = Field(description="e.g. 'Scale plan free for 3 months'")
    conditions: list[str] = Field(default_factory=list, description="who can use it, in words")
    starts_at: datetime | None = None
    expires_at: datetime | None = None


def _conditions(r) -> list[str]:
    out = []
    if r.who == "new":
        out.append("for new businesses")
    elif r.who == "unpaid":
        out.append("for businesses not yet on a paid plan")
    if r.industries:
        out.append("for " + ", ".join(INDUSTRY_NAMES.get(i, i).lower() for i in r.industries))
    if r.private:
        out.append("only for the people it was given to")
    return out


@router.get("/public/coupons/{code}", response_model=CouponInfo)
async def coupon_info(code: str, db: AnonDB, request: Request) -> CouponInfo:
    await limiter.hit(f"coupon-info:{client_ip(request)}", per_minute=30)
    r = (await db.execute(text("SELECT * FROM coupon_places(:c)"), {"c": code[:24]})).first()
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "that coupon doesn't exist")
    return CouponInfo(code=r.code, kind=r.kind, plan=r.plan, plan_name=plan_of(r.plan).name if r.plan else None,
                      months=r.months, places_left=r.places_left, open=r.open, offer=_words(r),
                      conditions=_conditions(r), starts_at=r.starts_at, expires_at=r.expires_at)


# ------------------------------------------------------------------------------ organisation --
class OrgCouponItem(BaseModel):
    code: str
    kind: Kind
    offer: str
    ends_at: datetime
    running: bool
    used: bool = Field(default=False, description="a percent-off coupon already paid a subscription")


class OrgCouponOut(BaseModel):
    code: str | None = Field(description="the free-plan coupon, if any (as before)")
    plan: str | None
    plan_name: str | None
    ends_at: datetime | None
    running: bool = Field(description="the coupon's plan applies now")
    superseded: bool = Field(description="a paid plan was chosen, so the coupon no longer matters")
    coupons: list[OrgCouponItem] = Field(default_factory=list, description="every coupon this organisation used")


@router.get("/orgs/{org_id}/coupon", response_model=OrgCouponOut)
async def org_coupon(org_id: uuid.UUID, db: TenantDB) -> OrgCouponOut:
    if not (await db.execute(text("SELECT :o = ANY (private.member_orgs())"), {"o": org_id})).scalar():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "organisation not found")
    rows = (await db.execute(text(
        "SELECT r.*, (SELECT p.plan FROM org_plans p WHERE p.org_id = r.org_id) AS paid"
        " FROM coupon_redemptions r WHERE r.org_id = :o ORDER BY r.redeemed_at"), {"o": org_id})).all()
    now = datetime.now(UTC)
    items = [OrgCouponItem(code=r.code, kind=r.kind, offer=_words(r), ends_at=r.ends_at,
                           running=r.ends_at > now and r.used_at is None, used=r.used_at is not None) for r in rows]
    free = next((r for r in rows if r.kind == "free_plan"), None)
    if free is None:
        return OrgCouponOut(code=None, plan=None, plan_name=None, ends_at=None, running=False, superseded=False,
                            coupons=items)
    paid = bool(free.paid and free.paid != "free")
    return OrgCouponOut(code=free.code, plan=free.plan, plan_name=plan_of(free.plan).name, ends_at=free.ends_at,
                        running=not paid and free.ends_at > now, superseded=paid, coupons=items)


class ApplyIn(BaseModel):
    code: str = Field(pattern=CODE)


RESULT = {"unknown": (404, "that coupon doesn't exist or has ended"),
          "not_started": (409, "this coupon can't be used yet"),
          "full": (409, "all the places for this coupon have been taken"),
          "already": (409, "this organisation has already used a coupon of this kind"),
          "person": (409, "you've already used this coupon for another organisation"),
          "paid": (409, "this organisation is already on a paid plan"),
          "not_new": (409, "this coupon is for new businesses only"),
          "too_late": (409, "this coupon had to be used soon after signing up"),
          "industry": (409, "this coupon is for a different kind of business"),
          "not_for_you": (403, "this coupon is private: it was given to someone else")}


@router.post("/orgs/{org_id}/coupon", response_model=OrgCouponOut)
async def apply_coupon(org_id: uuid.UUID, body: ApplyIn, user_id: UserId, db: TenantDB, svc: Svc) -> OrgCouponOut:
    await limiter.hit(f"coupon-apply:{user_id}", per_minute=10)
    try:
        async with db.begin_nested():
            res = (await db.execute(text("SELECT private.use_coupon(:o, :c)"), {"o": org_id, "c": body.code})).scalar()
    except DBAPIError as exc:
        raise_for_db(exc, "organisation not found")
        raise
    if res != "ok":
        code, msg = RESULT.get(res, (422, "that coupon can't be used"))
        raise HTTPException(code, msg)
    svc.router.gate.forget(org_id)        # plan limits are cached briefly
    return await org_coupon(org_id, db)


# --------------------------------------------------------------------------- Kritvia's team --
class CouponUse(BaseModel):
    org_id: uuid.UUID
    org_name: str | None
    owner_email: str | None
    redeemed_at: datetime
    ends_at: datetime
    used_at: datetime | None = None
    paid_plan: str | None


class CouponFields(BaseModel):
    kind: Kind = "free_plan"
    plan: PaidPlan | None = Field(default=None, description="free_plan: the plan given")
    months: int | None = Field(default=None, ge=1, le=12, description="free_plan or ai_tokens: how long; "
                                                                        "percent_off: billing cycles (as in the Razorpay offer)")
    days: int | None = Field(default=None, ge=1, le=365, description="free_plan (instead of months) or trial_days")
    percent: int | None = Field(default=None, ge=1, le=100)
    razorpay_offer_id: str | None = Field(default=None, pattern=r"^offer_[A-Za-z0-9]{6,40}$")
    plans: list[PaidPlan] = Field(default_factory=list, description="percent_off: only these plans (none = any)")
    periods: list[Period] = Field(default_factory=list, description="percent_off: only these billing periods")
    tokens: int | None = Field(default=None, ge=1000, le=1_000_000_000)
    industries: list[Industry] = Field(default_factory=list, description="none = every industry")
    who: Who = "unpaid"
    signup_days: int | None = Field(default=None, ge=1, le=365, description="who=new: used within this many days")
    emails: list[str] = Field(default_factory=list, max_length=500)
    domains: list[str] = Field(default_factory=list, max_length=50)
    starts_at: datetime | None = None
    expires_at: datetime | None = None
    max_uses: int = Field(default=100, ge=1, le=100000)
    note: str | None = Field(default=None, max_length=200)
    active: bool = True

    @field_validator("emails")
    @classmethod
    def _emails(cls, v: list[str]) -> list[str]:
        out = sorted({e.strip().lower() for e in v if e.strip()})
        bad = [e for e in out if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", e)]
        if bad:
            raise ValueError(f"not an email address: {bad[0]}")
        return out

    @field_validator("domains")
    @classmethod
    def _domains(cls, v: list[str]) -> list[str]:
        out = sorted({d.strip().lower().lstrip("@") for d in v if d.strip()})
        bad = [d for d in out if not re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)+", d)]
        if bad:
            raise ValueError(f"not an email domain: {bad[0]}")
        return out

    @model_validator(mode="after")
    def _by_kind(self) -> CouponFields:
        k = self.kind
        if k == "free_plan":
            if not self.plan:
                raise ValueError("choose the plan the coupon gives")
            if (self.months is None) == (self.days is None):
                raise ValueError("give either months or days for the free plan")
        elif k == "percent_off":
            if not self.percent or not self.razorpay_offer_id:
                raise ValueError("a percentage off needs the percent and the Razorpay offer id")
        elif k == "trial_days":
            if not self.days:
                raise ValueError("give the number of extra trial days")
        elif k == "ai_tokens":
            if not self.tokens or not self.months:
                raise ValueError("give the extra tokens a month and for how many months")
        # fields that don't belong to the kind are dropped, so a coupon never carries a stray value
        keep = {"free_plan": {"plan", "months", "days"}, "percent_off": {"percent", "razorpay_offer_id", "plans",
                                                                         "periods", "months"},
                "trial_days": {"days"}, "ai_tokens": {"tokens", "months"}}[k]
        for f, empty in (("plan", None), ("months", None), ("days", None), ("percent", None),
                         ("razorpay_offer_id", None), ("plans", []), ("periods", []), ("tokens", None)):
            if f not in keep:
                setattr(self, f, empty)
        if self.who != "new":
            self.signup_days = None
        if self.starts_at and self.expires_at and self.expires_at <= self.starts_at:
            raise ValueError("the coupon must end after it starts")
        return self


class CouponIn(CouponFields):
    code: str = Field(pattern=CODE)


class StaffCoupon(CouponFields):
    code: str
    offer: str
    uses: int
    status: Literal["scheduled", "open", "full", "ended", "off"]
    conditions: list[str]
    created_at: datetime
    used_by: list[CouponUse]


class CouponOptions(BaseModel):
    kinds: dict[str, str]
    plans: dict[str, str]
    industries: dict[str, str]
    who: dict[str, str]


def _status(r) -> str:
    now = datetime.now(UTC)
    if not r.active:
        return "off"
    if r.expires_at and r.expires_at <= now:
        return "ended"
    if r.starts_at and r.starts_at > now:
        return "scheduled"
    return "full" if r.uses >= r.max_uses else "open"


def _staff_conditions(r) -> list[str]:
    out = [WHO_NAMES[r.who] + (f", within {_plural(r.signup_days, 'day')} of signing up" if r.signup_days else "")]
    if r.industries:
        out.append("Industries: " + ", ".join(INDUSTRY_NAMES[i] for i in r.industries))
    if r.emails or r.domains:
        out.append(f"Private: {_plural(len(r.emails), 'email')}, {_plural(len(r.domains), 'domain')}")
    return out


@router.get("/staff/coupons/options", response_model=CouponOptions)
async def staff_options(user_id: UserId, db: TenantDB) -> CouponOptions:
    await _staff(db, user_id)
    return CouponOptions(kinds=KIND_NAMES, plans={p: plan_of(p).name for p in ("starter", "growth", "scale")},
                         industries=INDUSTRY_NAMES, who=WHO_NAMES)


@router.get("/staff/coupons", response_model=list[StaffCoupon])
async def staff_coupons(user_id: UserId, db: TenantDB) -> list[StaffCoupon]:
    await _staff(db, user_id)
    uses: dict[str, list[CouponUse]] = {}
    for u in (await db.execute(text("SELECT * FROM private.staff_coupon_uses(NULL)"))).all():
        uses.setdefault(u.code, []).append(CouponUse(org_id=u.org_id, org_name=u.org_name, owner_email=u.owner_email,
                                                     redeemed_at=u.redeemed_at, ends_at=u.ends_at, used_at=u.used_at,
                                                     paid_plan=u.paid_plan))
    out = []
    for r in (await db.execute(text("SELECT * FROM private.staff_coupons()"))).all():
        out.append(StaffCoupon(
            code=r.code, kind=r.kind, plan=r.plan, months=r.months, days=r.days, percent=r.percent,
            razorpay_offer_id=r.razorpay_offer_id, plans=list(r.plans or []), periods=list(r.periods or []),
            tokens=r.tokens, industries=list(r.industries or []), who=r.who, signup_days=r.signup_days,
            emails=list(r.emails or []), domains=list(r.domains or []), starts_at=r.starts_at,
            expires_at=r.expires_at, max_uses=r.max_uses, note=r.note, active=r.active, offer=_words(r),
            uses=r.uses, status=_status(r), conditions=_staff_conditions(r), created_at=r.created_at,
            used_by=uses.get(r.code, [])))
    return out


SAVE = {"exists": (409, "a coupon with this code already exists"), "missing": (404, "coupon not found"),
        "used": (409, "this coupon has been used, so what it gives can't change; make a new code instead")}


async def _save(db, body: CouponFields, code: str, create: bool, user_id: uuid.UUID) -> None:
    data = body.model_dump(mode="json") | {"code": code.upper()}
    try:
        async with db.begin_nested():
            res = (await db.execute(text("SELECT private.staff_save_coupon(CAST(:p AS jsonb), :c, :u)"),
                                    {"p": json.dumps(data), "c": create, "u": user_id})).scalar()
    except DBAPIError as exc:
        raise HTTPException(422, "those coupon settings aren't valid") from exc
    if res != "ok":
        raise HTTPException(*SAVE[res])


@router.post("/staff/coupons", response_model=list[StaffCoupon], status_code=201)
async def staff_create(body: CouponIn, user_id: UserId, db: TenantDB) -> list[StaffCoupon]:
    await _staff(db, user_id)
    await _save(db, body, body.code, True, user_id)
    return await staff_coupons(user_id, db)


@router.put("/staff/coupons/{code}", response_model=list[StaffCoupon])
async def staff_update(code: str, body: CouponFields, user_id: UserId, db: TenantDB) -> list[StaffCoupon]:
    await _staff(db, user_id)
    await _save(db, body, code, False, user_id)
    return await staff_coupons(user_id, db)


class StaffCouponIn(BaseModel):
    active: bool
    max_uses: int | None = Field(default=None, ge=1, le=100000)


@router.patch("/staff/coupons/{code}", response_model=list[StaffCoupon])
async def staff_set(code: str, body: StaffCouponIn, user_id: UserId, db: TenantDB) -> list[StaffCoupon]:
    await _staff(db, user_id)
    await db.execute(text("SELECT private.staff_set_coupon(:c, :a, :m)"),
                     {"c": code.upper(), "a": body.active, "m": body.max_uses})
    return await staff_coupons(user_id, db)


@router.delete("/staff/coupons/{code}", status_code=204)
async def staff_delete(code: str, user_id: UserId, db: TenantDB) -> None:
    await _staff(db, user_id)
    res = (await db.execute(text("SELECT private.staff_delete_coupon(:c)"), {"c": code.upper()})).scalar()
    if res == "used":
        raise HTTPException(status.HTTP_409_CONFLICT, "this coupon has been used; switch it off instead")
    if res == "missing":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "coupon not found")


@router.get("/staff/coupons/{code}/uses.csv", response_class=Response)
async def staff_uses_csv(code: str, user_id: UserId, db: TenantDB) -> Response:
    await _staff(db, user_id)
    rows = (await db.execute(text("SELECT * FROM private.staff_coupon_uses(:c)"), {"c": code.upper()})).all()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["code", "organisation", "owner email", "used on", "ends", "paid subscription", "now pays"])
    for r in rows:
        w.writerow([r.code, r.org_name or "", r.owner_email or "", r.redeemed_at.date().isoformat(),
                    r.ends_at.date().isoformat(), r.used_at.date().isoformat() if r.used_at else "", r.paid_plan or ""])
    return Response(buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="coupon-{code.upper()}-uses.csv"'})
