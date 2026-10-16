"""Coupons: a paid plan free for a few months, for the first N organisations (migration 0049).

  GET   /public/coupons/{code}       anyone: what the code gives and how many places are left
  GET   /orgs/{org_id}/coupon        members: the organisation's coupon, if it has one
  POST  /orgs/{org_id}/coupon        owners: apply a code (once per organisation and per person)
  GET   /staff/coupons               Kritvia's team: codes and who used them
  PATCH /staff/coupons/{code}        Kritvia's team: switch a code off/on, change its places

While a coupon runs, an organisation without a paid plan works on the coupon's plan. When it ends,
the organisation is back on the Free plan with 7 days to choose a plan. Nothing is ever charged
because of a coupon.
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.deps import AnonDB, Svc, TenantDB, UserId
from kritvia_api.errors import raise_for_db
from kritvia_api.plans import plan as plan_of
from kritvia_api.ratelimit import client_ip, limiter
from kritvia_api.routers.partners import _staff

router = APIRouter(tags=["coupons"])
CODE = r"^[A-Za-z0-9]{4,20}$"


class CouponInfo(BaseModel):
    code: str
    plan: str
    plan_name: str
    months: int
    places_left: int
    open: bool
    offer: str = Field(description="e.g. 'Scale plan free for 3 months'")


def _offer(plan: str, months: int) -> str:
    return f"{plan_of(plan).name} plan free for {months} month{'s' if months != 1 else ''}"


@router.get("/public/coupons/{code}", response_model=CouponInfo)
async def coupon_info(code: str, db: AnonDB, request: Request) -> CouponInfo:
    await limiter.hit(f"coupon-info:{client_ip(request)}", per_minute=30)
    r = (await db.execute(text("SELECT * FROM coupon_places(:c)"), {"c": code[:20]})).first()
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "that coupon doesn't exist")
    return CouponInfo(code=r.code, plan=r.plan, plan_name=plan_of(r.plan).name, months=r.months,
                      places_left=r.places_left, open=r.open, offer=_offer(r.plan, r.months))


class OrgCouponOut(BaseModel):
    code: str | None
    plan: str | None
    plan_name: str | None
    ends_at: datetime | None
    running: bool = Field(description="the coupon's plan applies now")
    superseded: bool = Field(description="a paid plan was chosen, so the coupon no longer matters")


@router.get("/orgs/{org_id}/coupon", response_model=OrgCouponOut)
async def org_coupon(org_id: uuid.UUID, db: TenantDB) -> OrgCouponOut:
    if not (await db.execute(text("SELECT :o = ANY (private.member_orgs())"), {"o": org_id})).scalar():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "organisation not found")
    r = (await db.execute(text(
        "SELECT r.code, r.plan, r.ends_at, (SELECT p.plan FROM org_plans p WHERE p.org_id = r.org_id) AS paid"
        " FROM coupon_redemptions r WHERE r.org_id = :o"), {"o": org_id})).first()
    if r is None:
        return OrgCouponOut(code=None, plan=None, plan_name=None, ends_at=None, running=False, superseded=False)
    paid = bool(r.paid and r.paid != "free")
    return OrgCouponOut(code=r.code, plan=r.plan, plan_name=plan_of(r.plan).name, ends_at=r.ends_at,
                        running=not paid and r.ends_at > datetime.now(UTC), superseded=paid)


class ApplyIn(BaseModel):
    code: str = Field(pattern=CODE)


RESULT = {"unknown": (404, "that coupon doesn't exist or has ended"),
          "full": (409, "all the places for this coupon have been taken"),
          "already": (409, "this organisation has already used a coupon"),
          "person": (409, "you've already used this coupon for another organisation"),
          "paid": (409, "this organisation is already on a paid plan")}


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


# --------------------------------------------------------------- Kritvia's team --
class CouponUse(BaseModel):
    org_id: uuid.UUID
    org_name: str | None
    owner_email: str | None
    redeemed_at: datetime
    ends_at: datetime
    paid_plan: str | None


class StaffCoupon(BaseModel):
    code: str
    offer: str
    max_uses: int
    uses: int
    active: bool
    expires_at: datetime | None
    note: str | None
    used_by: list[CouponUse]


@router.get("/staff/coupons", response_model=list[StaffCoupon])
async def staff_coupons(user_id: UserId, db: TenantDB) -> list[StaffCoupon]:
    await _staff(db, user_id)
    out: dict[str, StaffCoupon] = {}
    for r in (await db.execute(text("SELECT * FROM private.staff_coupons()"))).all():
        c = out.setdefault(r.code, StaffCoupon(code=r.code, offer=_offer(r.plan, r.months), max_uses=r.max_uses,
                                               uses=r.uses, active=r.active, expires_at=r.expires_at, note=r.note,
                                               used_by=[]))
        if r.org_id:
            c.used_by.append(CouponUse(org_id=r.org_id, org_name=r.org_name, owner_email=r.owner_email,
                                       redeemed_at=r.redeemed_at, ends_at=r.ends_at, paid_plan=r.paid_plan))
    return list(out.values())


class StaffCouponIn(BaseModel):
    active: bool
    max_uses: int | None = Field(default=None, ge=1, le=100000)


@router.patch("/staff/coupons/{code}", response_model=list[StaffCoupon])
async def staff_set(code: str, body: StaffCouponIn, user_id: UserId, db: TenantDB) -> list[StaffCoupon]:
    await _staff(db, user_id)
    await db.execute(text("SELECT private.staff_set_coupon(:c, :a, :m)"),
                     {"c": code.upper(), "a": body.active, "m": body.max_uses})
    return await staff_coupons(user_id, db)
