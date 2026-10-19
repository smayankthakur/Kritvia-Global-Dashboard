"""Getting paid: the business's UPI ID and Razorpay account, and each invoice's public payment page.

  GET/PUT /ventures/{v}/payment-settings      UPI ID and payee name (admins change them)
  POST    /ventures/{v}/connectors/razorpay   the business's own Razorpay keys (admins)
  GET     /public/pay/{token}                 the payment page's facts (no sign-in)
  POST    /public/pay/{token}/online          a Razorpay payment link for what is still owed
  POST    /public/pay/{token}/paid            the customer says they paid by UPI (tells the team)
  POST    /hooks/razorpay/{connector}         Razorpay's signed payment_link.paid: records the payment
"""
from __future__ import annotations

import json
import secrets
import uuid
from datetime import date, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.config import get_settings
from kritvia_api.db.session import tenant_tx
from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.errors import raise_for_db
from kritvia_api.ratelimit import client_ip, limiter
from kritvia_api.routers.invoices import pay_url, today_ist
from kritvia_api.services import push
from kritvia_api.services.crypto import EnvelopeCrypto
from kritvia_api.services.payments import KEY_ID, UPI_ID, RazorpayError, paid_event, upi_link, verify_webhook
from kritvia_api.services.quota import PlanRestricted, require_integration
from kritvia_api.services.security_log import security_event
from kritvia_api.workflows.collections import rupees

router = APIRouter(tags=["payments"])
SECRET = "connector.secret"


async def _require_admin(db, venture_id: uuid.UUID) -> uuid.UUID:
    org = await venture_org(db, venture_id)
    if not (await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only the business's admins can change how it gets paid")
    return org


class RazorpayInfo(BaseModel):
    key_id: str
    webhook_url: str
    last_error: str | None


class PaymentSettings(BaseModel):
    upi_id: str | None = Field(default=None, max_length=300, description="e.g. glowsalon@okicici")
    payee_name: str | None = Field(default=None, max_length=100, description="shown in the customer's UPI app")

    @field_validator("upi_id")
    @classmethod
    def _upi(cls, v: str | None) -> str | None:
        v = (v or "").strip() or None
        if v and not UPI_ID.match(v):
            raise ValueError("that doesn't look like a UPI ID (name@bank, e.g. glowsalon@okicici)")
        return v


class PaymentSettingsOut(PaymentSettings):
    razorpay: RazorpayInfo | None
    can_edit: bool


def _hook_url(connector_id: uuid.UUID) -> str:
    return f"{get_settings().public_api_url.rstrip('/')}/hooks/razorpay/{connector_id}"


@router.get("/ventures/{venture_id}/payment-settings", response_model=PaymentSettingsOut)
async def get_settings_(venture_id: uuid.UUID, db: TenantDB) -> PaymentSettingsOut:
    await venture_org(db, venture_id)
    s = (await db.execute(text("SELECT upi_id, payee_name FROM venture_payment_settings WHERE venture_id = :v"),
                          {"v": venture_id})).first()
    rz = (await db.execute(text("SELECT id, external_id, last_error FROM connectors WHERE venture_id = :v"
                                " AND provider = 'razorpay' AND status = 'active'"), {"v": venture_id})).first()
    admin = bool((await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar())
    return PaymentSettingsOut(
        upi_id=s.upi_id if s else None, payee_name=s.payee_name if s else None, can_edit=admin,
        razorpay=RazorpayInfo(key_id=rz.external_id, webhook_url=_hook_url(rz.id), last_error=rz.last_error) if rz else None)


@router.put("/ventures/{venture_id}/payment-settings", response_model=PaymentSettingsOut)
async def put_settings(venture_id: uuid.UUID, body: PaymentSettings, user_id: UserId, db: TenantDB) -> PaymentSettingsOut:
    org = await _require_admin(db, venture_id)
    await db.execute(text(
        "INSERT INTO venture_payment_settings (venture_id, org_id, upi_id, payee_name, updated_by)"
        " VALUES (:v, :o, :u, :p, :by) ON CONFLICT (venture_id) DO UPDATE SET upi_id = EXCLUDED.upi_id,"
        " payee_name = EXCLUDED.payee_name, updated_by = EXCLUDED.updated_by, updated_at = now()"),
        {"v": venture_id, "o": org, "u": body.upi_id, "p": (body.payee_name or "").strip() or None, "by": user_id})
    return await get_settings_(venture_id, db)


class RazorpayConnectIn(BaseModel):
    key_id: str = Field(min_length=12, max_length=60, description="rzp_live_… or rzp_test_…")
    key_secret: str = Field(min_length=10, max_length=100, description="stored encrypted, never shown again")


class RazorpayConnectOut(BaseModel):
    connector_id: uuid.UUID
    webhook_url: str
    webhook_secret: str = Field(description="shown once: paste it in Razorpay with the webhook address")
    events: list[str]


@router.post("/ventures/{venture_id}/connectors/razorpay", response_model=RazorpayConnectOut, status_code=201)
async def connect_razorpay(venture_id: uuid.UUID, body: RazorpayConnectIn, user_id: UserId, db: TenantDB,
                           svc: Svc) -> RazorpayConnectOut:
    """Connect the business's own Razorpay account. The keys are checked with Razorpay and stored
    encrypted; Kritvia makes a webhook secret for Razorpay to sign its payment notices with."""
    org = await _require_admin(db, venture_id)
    try:
        await require_integration(db, venture_id, "razorpay")
    except PlanRestricted as exc:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, str(exc)) from None
    key_id, key_secret = body.key_id.strip(), body.key_secret.strip()
    if not KEY_ID.match(key_id):
        raise HTTPException(422, "the key id starts with rzp_live_ (or rzp_test_ for trying it out)")
    try:
        await svc.razorpay.check(key_id, key_secret)
    except RazorpayError as exc:
        raise HTTPException(422, str(exc)) from None
    hook_secret = secrets.token_urlsafe(32)
    try:
        async with db.begin_nested():
            cid = (await db.execute(text(
                "INSERT INTO connectors (org_id, venture_id, provider, account_email, external_id, scopes, meta, created_by)"
                " VALUES (:o, :v, 'razorpay', :mode, :k, ARRAY['payment_links'], CAST(:m AS jsonb), :u)"
                " ON CONFLICT (venture_id, provider) DO UPDATE SET status = 'active', external_id = EXCLUDED.external_id,"
                " account_email = EXCLUDED.account_email, meta = EXCLUDED.meta, last_error = NULL, updated_at = now()"
                " RETURNING id"),
                {"o": org, "v": venture_id, "k": key_id, "u": user_id,
                 "mode": "live" if key_id.startswith("rzp_live_") else "test mode",
                 "m": json.dumps({"live": key_id.startswith("rzp_live_")})})).scalar_one()
            enc = await EnvelopeCrypto(db, svc.keys).encrypt(
                venture_id, SECRET, json.dumps({"key_secret": key_secret, "webhook_secret": hook_secret}))
            await db.execute(text(
                "INSERT INTO connector_tokens (connector_id, org_id, venture_id, secret_enc) VALUES (:c, :o, :v, :s)"
                " ON CONFLICT (connector_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, updated_at = now()"),
                {"c": cid, "o": org, "v": venture_id, "s": enc})
            # links made with the old account can't be checked any more
            await db.execute(text("UPDATE invoices SET pay_link_id = NULL, pay_link_url = NULL, pay_link_paise = NULL"
                                  " WHERE venture_id = :v AND status = 'open'"), {"v": venture_id})
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    return RazorpayConnectOut(connector_id=cid, webhook_url=_hook_url(cid), webhook_secret=hook_secret,
                              events=["payment_link.paid"])


# --------------------------------------------------------------- payment page --
class UpiOut(BaseModel):
    upi_id: str
    payee_name: str
    link: str = Field(description="upi://pay link with the amount; the page shows it as a QR too")


class PayPageOut(BaseModel):
    business: str
    number: str
    customer_name: str
    amount_paise: int
    balance_paise: int
    amount_text: str
    due_on: date
    status: str
    upi: UpiOut | None
    online: bool = Field(description="card, netbanking and UPI through the business's Razorpay")
    customer_says_paid: bool


async def _page(token: str):
    async with tenant_tx(None, "system") as conn:
        r = (await conn.execute(text("SELECT * FROM private.public_invoice(:t)"), {"t": token})).first()
    if r is None or r.status in ("cancelled", "draft"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "this payment link isn't valid")
    return r


@router.get("/public/pay/{token}", response_model=PayPageOut)
async def pay_page(token: str, request: Request) -> PayPageOut:
    await limiter.hit(f"pay-page:{client_ip(request)}", per_minute=60)
    r = await _page(token)
    note = f"Invoice {r.number}" if r.number else f"{r.business} invoice"
    upi = None
    if r.upi_id and r.status == "open" and r.balance_paise > 0:
        upi = UpiOut(upi_id=r.upi_id, payee_name=r.payee_name, link=upi_link(r.upi_id, r.payee_name, r.balance_paise, note))
    return PayPageOut(business=r.business, number=r.number, customer_name=r.customer_name, amount_paise=r.amount_paise,
                      balance_paise=r.balance_paise if r.status == "open" else 0,
                      amount_text=rupees(r.balance_paise if r.status == "open" else r.amount_paise), due_on=r.due_on,
                      status=r.status, upi=upi, online=bool(r.razorpay) and r.status == "open",
                      customer_says_paid=r.customer_says_paid_at is not None)


async def _razorpay_keys(run_as: uuid.UUID, venture_id: uuid.UUID, svc) -> tuple[uuid.UUID, str, dict] | None:
    async with tenant_tx(run_as, "agent", "razorpay") as conn:
        row = (await conn.execute(text(
            "SELECT c.id, c.external_id, t.secret_enc FROM connectors c JOIN connector_tokens t ON t.connector_id = c.id"
            " WHERE c.venture_id = :v AND c.provider = 'razorpay' AND c.status = 'active'"), {"v": venture_id})).first()
        if row is None:
            return None
        raw = await EnvelopeCrypto(conn, svc.keys).decrypt_str(venture_id, SECRET, row.secret_enc)
    try:
        return row.id, row.external_id, json.loads(raw or "{}")
    except ValueError:
        return None


class OnlineOut(BaseModel):
    url: str


@router.post("/public/pay/{token}/online", response_model=OnlineOut)
async def pay_online(token: str, request: Request, svc: Svc) -> OnlineOut:
    """A Razorpay payment link for exactly what is still owed (made once, and again only if that changes)."""
    await limiter.hit(f"pay-online:{client_ip(request)}", per_minute=10)
    r = await _page(token)
    if r.status != "open" or r.balance_paise <= 0:
        raise HTTPException(status.HTTP_409_CONFLICT, "this invoice is already paid")
    keys = await _razorpay_keys(r.run_as, r.venture_id, svc)
    if keys is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "online payment isn't set up for this business")
    connector_id, key_id, sec = keys
    async with tenant_tx(r.run_as, "agent", "razorpay") as conn:
        inv = (await conn.execute(text(
            "SELECT pay_link_url, pay_link_paise, customer_email, customer_phone,"
            " (SELECT count(*) FROM invoice_payments p WHERE p.invoice_id = i.id) AS n"
            " FROM invoices i WHERE id = :i"), {"i": r.invoice_id})).first()
    if inv.pay_link_url and inv.pay_link_paise == r.balance_paise:
        return OnlineOut(url=inv.pay_link_url)
    try:
        link = await svc.razorpay.create_link(
            key_id, sec.get("key_secret", ""), invoice_id=r.invoice_id, attempt=int(datetime.now().timestamp()),
            paise=r.balance_paise,
            description=f"{r.business}: invoice {r.number}".strip() if r.number else f"{r.business}: invoice",
            customer={"name": r.customer_name[:100], "email": inv.customer_email or "",
                      "contact": ("+" + inv.customer_phone) if inv.customer_phone else ""},
            back_url=pay_url(token))
    except RazorpayError as exc:
        async with tenant_tx(r.run_as, "agent", "razorpay") as conn:
            await conn.execute(text("UPDATE connectors SET last_error = :e, updated_at = now() WHERE id = :c"),
                               {"e": str(exc)[:300], "c": connector_id})
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "online payment isn't working right now; pay by UPI or "
                                                         "ask the business") from None
    async with tenant_tx(r.run_as, "agent", "razorpay") as conn:
        await conn.execute(text("UPDATE invoices SET pay_link_id = :l, pay_link_url = :u, pay_link_paise = :p,"
                                " updated_at = now() WHERE id = :i"),
                           {"l": str(link["id"])[:60], "u": link["short_url"], "p": r.balance_paise, "i": r.invoice_id})
    return OnlineOut(url=link["short_url"])


class PaidClaimIn(BaseModel):
    reference: str | None = Field(default=None, max_length=60, description="the UPI reference (UTR), if handy")


@router.post("/public/pay/{token}/paid", response_model=PayPageOut)
async def customer_paid(token: str, body: PaidClaimIn, request: Request) -> PayPageOut:
    """The customer says they paid by UPI. Nothing is marked paid: the team is told and confirms it."""
    await limiter.hit(f"pay-claim:{client_ip(request)}", per_minute=5)
    r = await _page(token)
    if r.status == "open" and r.customer_says_paid_at is None:
        ref = "".join(ch for ch in (body.reference or "") if ch.isalnum())[:40] or None
        async with tenant_tx(r.run_as, "agent", "payments") as conn:
            await conn.execute(text("UPDATE invoices SET customer_says_paid_at = now(), customer_paid_ref = :r,"
                                    " updated_at = now() WHERE id = :i AND status = 'open'"),
                               {"r": ref, "i": r.invoice_id})
        await push.notify_venture(r.venture_id, title="A customer says they paid",
                                  body=f"{r.customer_name[:40]} · {rupees(r.balance_paise)} · confirm it on Invoices",
                                  url=f"/v/{r.venture_id}/invoices", tag=f"paid-{r.invoice_id}")
    return await pay_page(token, request)


# ------------------------------------------------------------ Razorpay webhook --
class HookOut(BaseModel):
    recorded: bool


@router.post("/hooks/razorpay/{connector_id}", response_model=HookOut)
async def razorpay_hook(connector_id: uuid.UUID, request: Request, svc: Svc) -> HookOut:
    """payment_link.paid from the business's Razorpay, signed with the secret Kritvia gave it. Records
    the payment once (Razorpay's payment id), marks the invoice paid when nothing is left, tells the team.
    Answers 200 once the signature checks out, so Razorpay doesn't retry what was handled."""
    await limiter.hit(f"hook-ip:{client_ip(request)}", per_minute=600)
    raw = await request.body()
    if len(raw) > 256 * 1024:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "payload too large")
    async with tenant_tx(None, "system") as conn:
        p = (await conn.execute(text("SELECT * FROM private.razorpay_principal(:c)"), {"c": connector_id})).first()
    keys = await _razorpay_keys(p.run_as, p.venture_id, svc) if p else None
    if p is None or keys is None or not verify_webhook(keys[2].get("webhook_secret", ""), raw,
                                                       request.headers.get("x-razorpay-signature", "")):
        await security_event("webhook.bad_signature", "warning", request=request, provider="razorpay-business")
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad signature")
    try:
        ev = paid_event(json.loads(raw))
    except ValueError:
        raise HTTPException(422, "body must be JSON") from None
    if ev is None:
        return HookOut(recorded=False)
    async with tenant_tx(p.run_as, "agent", "razorpay") as conn:
        inv = (await conn.execute(text(
            "SELECT id, org_id, customer_name, amount_paise, paid_paise, status, number FROM invoices"
            " WHERE venture_id = :v AND pay_link_id = :l FOR UPDATE"), {"v": p.venture_id, "l": ev["link_id"]})).first()
        if inv is None:
            return HookOut(recorded=False)
        added = (await conn.execute(text(
            "INSERT INTO invoice_payments (org_id, venture_id, invoice_id, amount_paise, paid_on, method, reference)"
            " VALUES (:o, :v, :i, :a, :d, 'razorpay', :ref) ON CONFLICT DO NOTHING RETURNING id"),
            {"o": inv.org_id, "v": p.venture_id, "i": inv.id, "a": ev["paise"], "d": today_ist(),
             "ref": ev["payment_id"]})).first()
        if added is None:
            return HookOut(recorded=False)               # delivered before
        if inv.status == "open":
            await conn.execute(text(
                "UPDATE invoices SET paid_paise = least(amount_paise, paid_paise + :a),"
                " status = CASE WHEN paid_paise + :a >= amount_paise THEN 'paid' ELSE status END,"
                " paid_on = :d, customer_says_paid_at = NULL, customer_paid_ref = NULL, updated_at = now()"
                " WHERE id = :i"), {"a": ev["paise"], "d": today_ist(), "i": inv.id})
    await push.notify_venture(p.venture_id, title="Invoice paid",
                              body=f"{inv.customer_name[:40]} paid {rupees(ev['paise'])} online",
                              url=f"/v/{p.venture_id}/invoices", tag=f"paid-{inv.id}")
    return HookOut(recorded=True)


__all__: list[Any] = ["router"]
