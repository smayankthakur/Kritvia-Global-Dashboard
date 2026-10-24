"""Email forwarding: a business's own Kritvia address, and the endpoint its forwarded mail arrives at; and
each person's private ask address (ask Kritvia by email: services/ask_anywhere.py, migration 0076).

See services/email_in.py and migration 0031. Setting up an address needs a venture admin; the
inbound endpoint is public but only accepts messages signed by the Cloudflare email worker.
"""
from __future__ import annotations

import logging

import re
import secrets
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import text

from kritvia_api.config import get_settings
from kritvia_api.db.session import tenant_tx
from kritvia_api.deps import Svc, TenantDB, UserId
from kritvia_api.ratelimit import client_ip, limiter
from kritvia_api.routers.connectors import _plan_allows, _require_admin
from kritvia_api.services import ask_anywhere, email_in
from kritvia_api.services.security_log import security_event

router = APIRouter(tags=["connectors"])


def _enabled() -> bool:
    s = get_settings()
    return bool(s.inbound_email_domain and s.inbound_email_secret)


class ForwardingOut(BaseModel):
    connector_id: uuid.UUID
    address: str
    gmail_code: str | None = None
    gmail_link: str | None = Field(default=None, description="Gmail's confirmation link (newer Gmail sends a link "
                                                              "instead of a code): open it to finish")
    gmail_mailbox: str | None = None
    last_mail_at: datetime | None = Field(default=None, description="when the last forwarded email arrived")
    forwarded_from: str | None = Field(default=None, description="the mailbox the last forwarded email came from")
    gmail_reads_it: bool = Field(default=False, description="Gmail is also connected with read access for that "
                                                            "mailbox: each email is still handled once")


def _local(slug: str) -> str:
    """A new address: the business's name and 128 random bits, so it can't be guessed from a forwarded mail's
    headers or found by trying (addresses made before this keep working)."""
    base = re.sub(r"[^a-z0-9]+", "-", slug.lower()).strip("-")[:30] or "biz"
    if base == "ask" or base.startswith("ask-"):   # "ask-" starts a person's ask address (round 3, B5)
        base = f"biz-{base}"[:30]
    return f"{base}-{secrets.token_hex(16)}"


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
    from kritvia_api.services.google import SCOPES
    meta = dict(row.meta or {})
    last = meta.get("last_mail_at")
    src = meta.get("forwarded_from") or meta.get("gmail_mailbox")
    g = (await db.execute(text("SELECT lower(account_email) AS email, scopes FROM connectors WHERE venture_id = :v"
                               " AND provider = 'google' AND status = 'active'"), {"v": venture_id})).first()
    return ForwardingOut(connector_id=row.id, address=row.account_email, gmail_code=meta.get("gmail_code") or None,
                         gmail_link=meta.get("gmail_link") or None, gmail_mailbox=meta.get("gmail_mailbox"),
                         last_mail_at=datetime.fromisoformat(last) if last else None,
                         forwarded_from=meta.get("forwarded_from"),
                         gmail_reads_it=bool(g and src and g.email == src.lower()
                                             and SCOPES["gmail.readonly"] in (g.scopes or [])))


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
    if ask_anywhere.is_ask_local(local):
        # A person asking their business by email (services/ask_anywhere.py). Mail that isn't verifiably from
        # that person is dropped without a bounce, so trying addresses tells nobody anything.
        out = await ask_anywhere.email_ask(svc, local, f"{local}@{s.inbound_email_domain.lower()}",
                                           email_in.parse(raw))
        if out != "unknown":
            return EmailInOut(accepted=True)
        # not an ask address after all: a business forwarding address made before "ask-" was kept out of
        # them (a business called "Ask Ginni") is looked up below like any other (round 3, B5)
    async with tenant_tx(None, "system") as conn:
        p = (await conn.execute(text("SELECT * FROM private.email_in_principal(:l)"), {"l": local})).first()
    if p is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown address")
    msg = email_in.parse(raw)
    confirm = email_in.gmail_confirmation(msg)
    async with tenant_tx(p.run_as, "agent", "email_in") as conn:
        if confirm:
            # Gmail asks the new forwarding address to confirm: the owner enters the code in Gmail, or (newer
            # Gmail) opens the confirmation link. Both are shown on Settings, and the owners are told now.
            # Only a confirmation Cloudflare verified as google.com's replaces one that is already waiting, so
            # mail sent straight to the address can't swap in someone else's mailbox.
            stored = (await conn.execute(text(
                "UPDATE connectors SET meta = meta || jsonb_build_object('gmail_code', CAST(:c AS text),"
                " 'gmail_link', CAST(:l AS text), 'gmail_mailbox', CAST(:m AS text)), updated_at = now()"
                " WHERE id = :id AND (CAST(:ver AS boolean) OR coalesce(meta ->> 'gmail_code', '') = ''"
                " AND coalesce(meta ->> 'gmail_link', '') = '') RETURNING id"),
                {"c": confirm["code"], "l": confirm["link"], "m": confirm["mailbox"], "id": p.connector_id,
                 "ver": bool(confirm.get("verified"))})).first()
            if stored is None:
                await security_event("email_in.unverified_confirmation", "warning", request=request, provider="email_in")
                return EmailInOut(accepted=True, confirmation=False)
            try:
                from kritvia_api.services.owner_news import tell_admins
                who = confirm["mailbox"] or "your mailbox"
                how = ("open Kritvia's Settings and press Confirm in Gmail (it opens Google's own confirmation page)"
                       if confirm["link"] else f"enter the code {confirm['code']} in Gmail's forwarding settings")
                await tell_admins(svc, conn, p.venture_id, subject=f"Finish email forwarding from {who}",
                                  body=f"Gmail asks to confirm forwarding {who} to Kritvia. To finish, {how}. Only do "
                                       f"this if {who} is your own mailbox.",
                                  path=f"/v/{p.venture_id}/settings", tag=f"gmail-forwarding-{p.venture_id}")
            except Exception:  # noqa: BLE001 - the code or link is on Settings either way
                logging.getLogger(__name__).info("forwarding confirmation note failed", exc_info=True)
            return EmailInOut(accepted=True, confirmation=True)
        # Mail is arriving: note when and from which mailbox; once Gmail itself forwards, its confirmation is done.
        from kritvia_api.services.pollers import forwarded_from
        via = forwarded_from(msg)
        await conn.execute(text(
            "UPDATE connectors SET cursor = now()::text, updated_at = now(), meta = (CASE WHEN CAST(:f AS text) IS NULL"
            " THEN meta ELSE meta - 'gmail_code' - 'gmail_link' || jsonb_build_object('forwarded_from', CAST(:f AS text))"
            " END) || jsonb_build_object('last_mail_at', CAST(:t AS text)) WHERE id = :id"),
            {"id": p.connector_id, "f": via, "t": datetime.now(UTC).isoformat()})
    if not await _plan_allows(p.run_as, p.venture_id, "gmail"):
        return EmailInOut(accepted=False)
    started = await deliver_forwarded(svc, p.org_id, p.venture_id, p.run_as, msg)
    return EmailInOut(accepted=True, started=started)


# ------------------------------------------------------------- ask by email --
async def _visible(db, venture_id: uuid.UUID) -> None:
    if (await db.execute(text("SELECT 1 FROM ventures WHERE id = :v"), {"v": venture_id})).first() is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "venture not found")


class AskAddressOut(BaseModel):
    available: bool = Field(description="this server receives email, so ask addresses work")
    exists: bool = False
    address: str | None = Field(default=None, description="the full address: only in the answer that made it")
    hint: str | None = Field(default=None, description="its last characters, to recognise it")
    created_at: datetime | None = None
    last_used_at: datetime | None = None
    your_email: str | None = Field(default=None, description="only mail from this address is answered")


@router.get("/ventures/{venture_id}/ask-address", response_model=AskAddressOut)
async def get_ask_address(venture_id: uuid.UUID, user_id: UserId, db: TenantDB) -> AskAddressOut:
    """Your private address for asking this business by email (only that it exists: the address is shown once)."""
    await _visible(db, venture_id)
    me = (await db.execute(text("SELECT email FROM users WHERE id = :u"), {"u": user_id})).scalar()
    row = (await db.execute(text("SELECT hint, created_at, last_used_at FROM ask_addresses"
                                 " WHERE venture_id = :v AND user_id = :u"), {"v": venture_id, "u": user_id})).first()
    if row is None:
        return AskAddressOut(available=_enabled(), your_email=me)
    return AskAddressOut(available=_enabled(), exists=True, hint=row.hint, created_at=row.created_at,
                         last_used_at=row.last_used_at, your_email=me)


@router.post("/ventures/{venture_id}/ask-address", response_model=AskAddressOut, status_code=201)
async def make_ask_address(venture_id: uuid.UUID, user_id: UserId, db: TenantDB) -> AskAddressOut:
    """Makes your ask address (a new one each time: the old one stops working). Shown once."""
    from sqlalchemy.exc import DBAPIError

    from kritvia_api.errors import raise_for_db
    await _visible(db, venture_id)
    if not _enabled():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "this server doesn't receive email yet")
    if not (await db.execute(text("SELECT :v = ANY (private.writable_ventures())"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "asking this business needs an operator or admin role")
    local = ask_anywhere.new_local()
    try:
        await db.execute(text("SELECT ask_address_set(:v, :h, :t)"),
                         {"v": venture_id, "h": ask_anywhere.local_hash(local), "t": local[-6:]})
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    me = (await db.execute(text("SELECT email FROM users WHERE id = :u"), {"u": user_id})).scalar()
    await security_event("ask_email.address_made", "info", user_id=user_id)
    return AskAddressOut(available=True, exists=True, address=f"{local}@{get_settings().inbound_email_domain.lower()}",
                         hint=local[-6:], created_at=datetime.now(UTC), your_email=me)


@router.delete("/ventures/{venture_id}/ask-address", status_code=204)
async def remove_ask_address(venture_id: uuid.UUID, user_id: UserId, db: TenantDB) -> None:
    await _visible(db, venture_id)
    await db.execute(text("DELETE FROM ask_addresses WHERE venture_id = :v AND user_id = :u"),
                     {"v": venture_id, "u": user_id})
