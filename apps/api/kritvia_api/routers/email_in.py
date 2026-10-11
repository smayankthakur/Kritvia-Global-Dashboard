"""Email forwarding: a business's own Kritvia address, and the endpoint its forwarded mail arrives at.

See services/email_in.py and migration 0031. Setting up an address needs a venture admin; the
inbound endpoint is public but only accepts messages signed by the Cloudflare email worker.
"""
from __future__ import annotations

import re
import secrets
import uuid

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import text

from kritvia_api.config import get_settings
from kritvia_api.db.session import tenant_tx
from kritvia_api.deps import Svc, TenantDB, UserId
from kritvia_api.ratelimit import client_ip, limiter
from kritvia_api.routers.connectors import _plan_allows, _require_admin
from kritvia_api.services import email_in
from kritvia_api.services.security_log import security_event

router = APIRouter(tags=["connectors"])


def _enabled() -> bool:
    s = get_settings()
    return bool(s.inbound_email_domain and s.inbound_email_secret)


class ForwardingOut(BaseModel):
    connector_id: uuid.UUID
    address: str
    gmail_code: str | None = None
    gmail_mailbox: str | None = None


def _local(slug: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", slug.lower()).strip("-")[:30] or "biz"
    return f"{base}-{secrets.token_hex(5)}"


@router.post("/ventures/{venture_id}/connectors/email-forwarding", response_model=ForwardingOut, status_code=201)
async def create_forwarding(venture_id: uuid.UUID, user_id: UserId, db: TenantDB) -> ForwardingOut:
    """Gives the business its own forwarding address (a new one each time: the old one stops working)."""
    org = await _require_admin(db, venture_id)
    if not _enabled():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "email forwarding is not set up on this server")
    slug = (await db.execute(text("SELECT slug FROM ventures WHERE id = :v"), {"v": venture_id})).scalar_one()
    local = _local(slug)
    address = f"{local}@{get_settings().inbound_email_domain.lower()}"
    cid = (await db.execute(text(
        "INSERT INTO connectors (org_id, venture_id, provider, account_email, external_id, created_by)"
        " VALUES (:o, :v, 'email_in', :a, :x, :u) ON CONFLICT (venture_id, provider) DO UPDATE SET"
        " account_email = EXCLUDED.account_email, external_id = EXCLUDED.external_id, status = 'active',"
        " meta = '{}'::jsonb, last_error = NULL, updated_at = now() RETURNING id"),
        {"o": org, "v": venture_id, "a": address, "x": local, "u": user_id})).scalar_one()
    return ForwardingOut(connector_id=cid, address=address)


@router.get("/ventures/{venture_id}/connectors/email-forwarding", response_model=ForwardingOut | None)
async def get_forwarding(venture_id: uuid.UUID, db: TenantDB) -> ForwardingOut | None:
    row = (await db.execute(text(
        "SELECT id, account_email, meta FROM connectors WHERE venture_id = :v AND provider = 'email_in'"
        " AND status = 'active'"), {"v": venture_id})).first()
    if row is None:
        return None
    meta = dict(row.meta or {})
    return ForwardingOut(connector_id=row.id, address=row.account_email, gmail_code=meta.get("gmail_code"),
                         gmail_mailbox=meta.get("gmail_mailbox"))


class EmailInOut(BaseModel):
    accepted: bool
    started: dict[str, int] = {}
    confirmation: bool = False


@router.post("/public/email-in", response_model=EmailInOut)
async def email_inbound(request: Request, svc: Svc) -> EmailInOut:
    """One forwarded email from the Cloudflare worker. 404 tells the worker to bounce the message."""
    from kritvia_api.services.pollers import deliver_forwarded
    await limiter.hit(f"email-in-ip:{client_ip(request)}", per_minute=600)
    s = get_settings()
    if not _enabled():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "email forwarding is not set up")
    raw = await request.body()
    if not email_in.signature_ok(s.inbound_email_secret, request.headers.get("x-kritvia-timestamp"), raw,
                                 request.headers.get("x-kritvia-signature")):
        await security_event("webhook.bad_signature", "warning", request=request, provider="email_in")
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad signature")
    local = email_in.local_part(request.headers.get("x-kritvia-to", ""), s.inbound_email_domain)
    if local is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown address")
    await limiter.hit(f"email-in:{local}", per_minute=120)
    async with tenant_tx(None, "system") as conn:
        p = (await conn.execute(text("SELECT * FROM private.email_in_principal(:l)"), {"l": local})).first()
    if p is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown address")
    msg = email_in.parse(raw)
    confirm = email_in.gmail_confirmation(msg)
    async with tenant_tx(p.run_as, "agent", "email_in") as conn:
        if confirm:
            # Gmail asks the new forwarding address to confirm; the owner copies this code into Gmail.
            await conn.execute(text(
                "UPDATE connectors SET meta = meta || jsonb_build_object('gmail_code', CAST(:c AS text),"
                " 'gmail_mailbox', CAST(:m AS text)), updated_at = now() WHERE id = :id"),
                {"c": confirm["code"], "m": confirm["mailbox"], "id": p.connector_id})
            return EmailInOut(accepted=True, confirmation=True)
        await conn.execute(text("UPDATE connectors SET cursor = now()::text, updated_at = now() WHERE id = :id"),
                           {"id": p.connector_id})
    if not await _plan_allows(p.run_as, p.venture_id, "gmail"):
        return EmailInOut(accepted=False)
    started = await deliver_forwarded(svc, p.org_id, p.venture_id, p.run_as, msg)
    return EmailInOut(accepted=True, started=started)
