"""Billing: Razorpay subscriptions, GST billing profile, invoices and the webhook that
moves an organisation between plans. Only organisation owners see or change billing."""
from __future__ import annotations

import hashlib
import hmac
import json
import uuid
from datetime import UTC, datetime
from typing import Any, Literal

import httpx
from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import text

from kritvia_api.config import get_settings
from kritvia_api.db.session import tenant_tx
from kritvia_api.deps import TenantDB
from kritvia_api.plans import SELF_SERVE, plan as plan_of
from kritvia_api.services.security_log import security_event
from kritvia_api.ratelimit import client_ip, limiter

router = APIRouter(tags=["billing"])
RAZORPAY = "https://api.razorpay.com/v1"
transport: httpx.AsyncBaseTransport | None = None   # tests inject a mock


def _plan_ids() -> dict[str, str]:
    """{"starter": id, "starter_annual": id, "growth": ..., "scale_annual": ...} for the configured ones."""
    s = get_settings()
    ids = {"starter": s.razorpay_plan_starter, "starter_annual": s.razorpay_plan_starter_annual,
           "growth": s.razorpay_plan_growth or s.razorpay_plan_pro, "growth_annual": s.razorpay_plan_growth_annual,
           "scale": s.razorpay_plan_scale, "scale_annual": s.razorpay_plan_scale_annual}
    return {k: v for k, v in ids.items() if v}


def _configured() -> bool:
    s = get_settings()
    return bool(s.razorpay_key_id and s.razorpay_key_secret and _plan_ids())


async def _razorpay(method: str, path: str, body: dict | None = None) -> dict[str, Any]:
    s = get_settings()
    async with httpx.AsyncClient(transport=transport, timeout=30,
                                 auth=(s.razorpay_key_id, s.razorpay_key_secret)) as c:
        r = await c.request(method, RAZORPAY + path, json=body)
    if r.status_code >= 400:
        try:
            msg = r.json().get("error", {}).get("description", "")
        except ValueError:
            msg = ""
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Razorpay refused the request: {msg or r.status_code}")
    return r.json()


async def _require_owner(db, org_id: uuid.UUID) -> None:
    if not (await db.execute(text("SELECT :o = ANY (private.owned_orgs())"), {"o": org_id})).scalar():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "organisation not found")


class BillingProfile(BaseModel):
    legal_name: str = Field(min_length=1, max_length=200)
    gstin: str | None = Field(default=None, pattern=r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$")
    address: str = Field(default="", max_length=500)
    state_code: str | None = Field(default=None, pattern=r"^[0-9]{2}$")
    email: str | None = Field(default=None, max_length=200)


class BillingEvent(BaseModel):
    event: str
    plan: str | None
    amount_paise: int | None
    invoice_url: str | None
    created_at: datetime


class BillingOut(BaseModel):
    configured: bool
    key_id: str | None
    profile: BillingProfile | None
    subscription_id: str | None
    subscription_status: str | None
    events: list[BillingEvent]


@router.get("/orgs/{org_id}/billing", response_model=BillingOut)
async def billing(org_id: uuid.UUID, db: TenantDB) -> BillingOut:
    await _require_owner(db, org_id)
    p = (await db.execute(text("SELECT legal_name, gstin, address, state_code, email FROM billing_profiles"
                               " WHERE org_id = :o"), {"o": org_id})).first()
    sub = (await db.execute(text("SELECT subscription_id, subscription_status FROM org_plans WHERE org_id = :o"),
                            {"o": org_id})).first()
    ev = (await db.execute(text("SELECT event, plan, amount_paise, invoice_url, created_at FROM billing_events"
                                " WHERE org_id = :o ORDER BY created_at DESC LIMIT 50"), {"o": org_id})).all()
    return BillingOut(configured=_configured(), key_id=get_settings().razorpay_key_id or None,
                      profile=BillingProfile(**p._mapping) if p else None,
                      subscription_id=sub.subscription_id if sub else None,
                      subscription_status=sub.subscription_status if sub else None,
                      events=[BillingEvent(**r._mapping) for r in ev])


@router.put("/orgs/{org_id}/billing/profile", response_model=BillingProfile)
async def put_profile(org_id: uuid.UUID, body: BillingProfile, db: TenantDB) -> BillingProfile:
    await _require_owner(db, org_id)
    if body.gstin and body.state_code and body.gstin[:2] != body.state_code:
        raise HTTPException(422, "the GSTIN's first two digits must match the state code")
    await db.execute(text(
        "INSERT INTO billing_profiles (org_id, legal_name, gstin, address, state_code, email)"
        " VALUES (:o, :n, :g, :a, :s, :e) ON CONFLICT (org_id) DO UPDATE SET legal_name = EXCLUDED.legal_name,"
        " gstin = EXCLUDED.gstin, address = EXCLUDED.address, state_code = EXCLUDED.state_code,"
        " email = EXCLUDED.email, updated_at = now()"),
        {"o": org_id, "n": body.legal_name, "g": body.gstin, "a": body.address, "s": body.state_code,
         "e": body.email})
    return body


class SubscribeIn(BaseModel):
    plan: Literal["starter", "growth", "scale"]
    period: Literal["monthly", "annual"] = "monthly"


class SubscribeOut(BaseModel):
    subscription_id: str
    checkout_url: str


@router.post("/orgs/{org_id}/billing/subscribe", response_model=SubscribeOut)
async def subscribe(org_id: uuid.UUID, body: SubscribeIn, db: TenantDB) -> SubscribeOut:
    """Creates a Razorpay subscription and returns its hosted payment page. The plan changes
    only when Razorpay confirms the payment through the webhook."""
    await _require_owner(db, org_id)
    if not _configured():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "payments are not set up on this server yet")
    key = body.plan if body.period == "monthly" else f"{body.plan}_annual"
    plan_id = _plan_ids().get(key)
    if not plan_id:
        raise HTTPException(422, f"the {body.period} {body.plan} plan is not available for purchase yet")
    prof = (await db.execute(text("SELECT legal_name, gstin, email FROM billing_profiles WHERE org_id = :o"),
                             {"o": org_id})).first()
    notes = {"org_id": str(org_id), "plan": body.plan, "period": body.period}
    if prof:
        notes.update({"legal_name": prof.legal_name[:200], "gstin": prof.gstin or ""})
    count = 120 if body.period == "monthly" else 10      # ten years either way
    sub = await _razorpay("POST", "/subscriptions", {"plan_id": plan_id, "total_count": count, "quantity": 1,
                                                      "customer_notify": 1, "notes": notes})
    return SubscribeOut(subscription_id=sub["id"], checkout_url=sub["short_url"])


@router.post("/orgs/{org_id}/billing/cancel", status_code=202)
async def cancel(org_id: uuid.UUID, db: TenantDB) -> dict:
    """Cancels at the end of the paid period; the webhook moves the org back to Free then."""
    await _require_owner(db, org_id)
    sub = (await db.execute(text("SELECT subscription_id FROM org_plans WHERE org_id = :o"), {"o": org_id})).scalar()
    if not sub:
        raise HTTPException(status.HTTP_409_CONFLICT, "there is no active subscription")
    await _razorpay("POST", f"/subscriptions/{sub}/cancel", {"cancel_at_cycle_end": 1})
    return {"cancelled_at_cycle_end": True}


# ------------------------------------------------------------------ webhook --
def minimum_paise(plan: str, annual: bool) -> int:
    """The least a genuine charge for this plan can be: our listed price, in paise, less ₹1
    for rounding. Anything below this is wrong."""
    p = plan_of(plan)
    rupees = (p.price_annual_inr or 0) if annual else p.price_inr
    return max(rupees * 100 - 100, 0)


PLAN_FOR_STATUS = {"activated": True, "charged": True, "resumed": True, "authenticated": False,
                   "pending": True, "halted": False, "cancelled": False, "completed": False, "paused": False}


@router.post("/public/billing/razorpay", status_code=200)
async def razorpay_webhook(request: Request) -> dict:
    """Razorpay → Kritvia. Verified with X-Razorpay-Signature (HMAC-SHA256 of the raw body with
    the webhook secret); duplicates are ignored by event id."""
    await limiter.hit(f"rzp-ip:{client_ip(request)}", per_minute=600)
    secret = get_settings().razorpay_webhook_secret
    if not secret:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "webhook not configured")
    raw = await request.body()
    if len(raw) > 256 * 1024:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "payload too large")
    sig = request.headers.get("x-razorpay-signature", "")
    good = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, good):
        await security_event("webhook.bad_signature", "warning", request=request, provider="razorpay")
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad signature")
    ev = json.loads(raw)
    event_id = request.headers.get("x-razorpay-event-id") or hashlib.sha256(raw).hexdigest()
    name = str(ev.get("event", ""))
    payload = ev.get("payload", {})
    sub = (payload.get("subscription") or {}).get("entity") or {}
    pay = (payload.get("payment") or {}).get("entity") or {}
    inv = (payload.get("invoice") or {}).get("entity") or {}
    notes = sub.get("notes") or inv.get("notes") or pay.get("notes") or {}
    try:
        org_id = uuid.UUID(str(notes.get("org_id", "")))
    except ValueError:
        return {"ignored": "no organisation in notes"}
    # The plan comes ONLY from the Razorpay plan id we configured on the server, never from
    # notes or anything the browser sent; the amount actually paid is checked against our price.
    by_id = {v: k for k, v in _plan_ids().items()}
    plan = None
    status_ = sub.get("status")
    amount = pay.get("amount") or inv.get("amount_paid") or inv.get("amount")
    if name.startswith("subscription."):
        paid = PLAN_FOR_STATUS.get(name.split(".", 1)[1])
        if paid is True:
            key = by_id.get(sub.get("plan_id", ""))
            plan = key.removesuffix("_annual") if key else None
            if plan not in SELF_SERVE:
                if sub.get("plan_id"):
                    await security_event("billing.unknown_plan", "warning", request=request, org_id=org_id,
                                         razorpay_plan=str(sub.get("plan_id"))[:40], event_name=name)
                plan = None   # only plans sold through checkout change here; Enterprise is set by hand
            elif amount is not None and int(amount) < minimum_paise(plan, key.endswith("_annual")):
                await security_event("billing.amount_mismatch", "critical", request=request, org_id=org_id,
                                     plan=key, paid_paise=int(amount), minimum_paise=minimum_paise(plan, key.endswith("_annual")))
                plan = None   # paid less than the plan costs: record the payment, don't grant the plan
        elif paid is False and name.split(".", 1)[1] in ("halted", "cancelled", "completed", "paused"):
            plan = "free"
    renews = datetime.fromtimestamp(sub["current_end"], UTC) if sub.get("current_end") else None
    async with tenant_tx(None, "system") as conn:
        fresh = (await conn.execute(text(
            "SELECT billing_record(:o, :e, :i, :s, :p, :st, :r, :a, :u)"),
            {"o": org_id, "e": name, "i": event_id, "s": sub.get("id") or inv.get("subscription_id"),
             "p": plan, "st": status_, "r": renews, "a": amount, "u": inv.get("short_url")})).scalar()
    if fresh and plan:
        await security_event("billing.plan_changed", "info", request=request, org_id=org_id, plan=plan, event_name=name)
        from kritvia_api.engine.context import get_services
        get_services().router.gate.forget(org_id)
        cap = plan_of(plan).autonomy_per_agent
        if cap != 0:   # a smaller plan: switch off earned autonomy beyond what it allows
            async with tenant_tx(None, "system") as conn:
                await conn.execute(text("SELECT limit_autonomy(:o, :c)"), {"o": org_id, "c": cap or 0})
    return {"ok": True, "duplicate": not fresh}
