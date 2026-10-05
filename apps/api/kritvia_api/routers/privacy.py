"""Privacy rights requests and product-email preferences.

POST /public/privacy-requests   anyone can ask to access, correct or erase their data, withdraw
                                consent, nominate someone, or raise a grievance — including people
                                who can't sign in and customers of businesses that use Kritvia.
                                Stored with deadlines, emailed to the grievance inbox; the
                                requester gets a reference. Identity is confirmed by replying from
                                the address given, never by collecting ID documents here.
POST /public/unsubscribe        one-click unsubscribe (RFC 8058) from product emails, using the
                                signed link in the email. Sign-in codes and security notices are
                                not product emails and always arrive.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import text

from kritvia_api.config import get_settings
from kritvia_api.db.session import tenant_tx
from kritvia_api.ratelimit import client_ip, limiter
from kritvia_api.services.mailer import MailError, get_mailer

router = APIRouter(tags=["privacy"])

Kind = Literal["access", "correct", "erase", "withdraw", "nominate", "grievance", "other"]
Relationship = Literal["account_holder", "business_customer", "nominee", "other"]
KIND_NAMES = {"access": "Access my data", "correct": "Correct my data", "erase": "Erase my data",
              "withdraw": "Withdraw consent", "nominate": "Nominate someone", "grievance": "Grievance",
              "other": "Other privacy question"}


class PrivacyRequestIn(BaseModel):
    kind: Kind
    relationship: Relationship
    name: str = Field(min_length=1, max_length=120)
    email: EmailStr
    business_name: str = Field(default="", max_length=200,
                               description="the business that holds your data, if you are its customer")
    details: str = Field(min_length=5, max_length=5000)
    website: str = Field(default="", max_length=200, description="leave empty (spam trap)")


class PrivacyRequestOut(BaseModel):
    reference: str
    acknowledge_by: datetime
    respond_by: datetime


@router.post("/public/privacy-requests", response_model=PrivacyRequestOut, status_code=202)
async def submit_privacy_request(body: PrivacyRequestIn, request: Request) -> PrivacyRequestOut:
    await limiter.hit(f"privacy-ip:{client_ip(request)}", per_minute=3)
    await limiter.hit(f"privacy-email:{body.email.lower()}", per_minute=2)
    if body.website:  # bots fill every field; answer as if accepted
        now = datetime.now().astimezone()
        return PrivacyRequestOut(reference="PR-RECEIVED", acknowledge_by=now, respond_by=now)
    async with tenant_tx(None, "system") as conn:
        row = (await conn.execute(
            text("SELECT * FROM privacy_request_submit(:k, :r, :n, :e, :b, :d, NULL)"),
            {"k": body.kind, "r": body.relationship, "n": body.name.strip(), "e": body.email,
             "b": body.business_name.strip(), "d": body.details.strip()})).first()
    if row is None:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "could not save your request")
    inbox = get_settings().support_inbox
    if inbox:
        try:
            await get_mailer().send(
                inbox, f"[Kritvia privacy {row.reference}] {KIND_NAMES[body.kind]}",
                f"Reference: {row.reference}\nRequest: {KIND_NAMES[body.kind]}\nFrom: {body.name} <{body.email}>\n"
                f"Relationship: {body.relationship}\nBusiness: {body.business_name or '-'}\n"
                f"Acknowledge by: {row.acknowledge_by:%d %b %Y}\nRespond by: {row.respond_by:%d %b %Y}\n\n"
                f"{body.details}\n\nConfirm identity by replying to the requester's address before acting.")
        except MailError:
            pass  # stored; the grievance officer still sees it in the database
    return PrivacyRequestOut(reference=row.reference, acknowledge_by=row.acknowledge_by, respond_by=row.respond_by)


# ------------------------------------------------------------ unsubscribe --
def _sign(user_id: uuid.UUID) -> str:
    key = get_settings().jwt_secret.encode()
    mac = hmac.new(key, b"product-email-optout:" + user_id.bytes, hashlib.sha256).digest()[:18]
    return base64.urlsafe_b64encode(user_id.bytes + mac).decode().rstrip("=")


def unsubscribe_token(user_id: uuid.UUID) -> str:
    return _sign(user_id)


def unsubscribe_url(user_id: uuid.UUID) -> str:
    """The page linked in the email body: shows what happens and confirms."""
    return f"{get_settings().public_web_url.rstrip('/')}/unsubscribe?t={unsubscribe_token(user_id)}"


def one_click_url(user_id: uuid.UUID) -> str:
    """The List-Unsubscribe header target: mail apps POST here (RFC 8058); the web app forwards it."""
    return f"{get_settings().public_web_url.rstrip('/')}/api/unsubscribe?t={unsubscribe_token(user_id)}"


async def send_product_email(conn, user_id: uuid.UUID, to: str, subject: str, body: str) -> bool:
    """The only way to send a product email (digest, tip, announcement): skips people who opted
    out, and always includes the unsubscribe link and one-click headers. Returns whether it sent."""
    if not await may_send_product_email(conn, user_id):
        return False
    await get_mailer().send(to, subject, body, unsubscribe_url=unsubscribe_url(user_id),
                            one_click_url=one_click_url(user_id))
    return True


def _verify(token: str) -> uuid.UUID | None:
    try:
        raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))
        uid = uuid.UUID(bytes=raw[:16])
    except (ValueError, TypeError):
        return None
    return uid if hmac.compare_digest(_sign(uid), token) else None


class UnsubscribeIn(BaseModel):
    token: str = Field(min_length=20, max_length=80)
    resubscribe: bool = False


@router.post("/public/unsubscribe")
async def unsubscribe(body: UnsubscribeIn, request: Request) -> dict:
    await limiter.hit(f"unsub-ip:{client_ip(request)}", per_minute=20)
    uid = _verify(body.token)
    if uid is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "this unsubscribe link is not valid")
    async with tenant_tx(None, "system") as conn:
        await conn.execute(text("SELECT product_email_optout(:u, :o)"), {"u": uid, "o": not body.resubscribe})
    return {"subscribed": body.resubscribe}


async def may_send_product_email(conn, user_id: uuid.UUID) -> bool:
    """Product emails (digests, tips, announcements) only go to people who haven't opted out."""
    return bool((await conn.execute(text("SELECT product_email_allowed(:u)"), {"u": user_id})).scalar())
