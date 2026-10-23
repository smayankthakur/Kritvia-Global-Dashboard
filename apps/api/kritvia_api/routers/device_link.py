"""Sign in on another device with a QR code, and the list of signed-in devices.

Two ways round, both ending with a normal session on the new device:

  Offer (computer -> phone): signed in on the computer, "Open on your phone" shows a QR.
    POST /auth/link/offer            (signed in)  -> id, token, url
    POST /auth/link/claim            (new device) token -> secret       the phone scanned it
    GET  /auth/link/{id}             (signed in)  -> status, device      the computer watches
    POST /auth/link/{id}/decide      (signed in)  approve / reject       on the computer
    POST /auth/link/redeem           (new device) token + secret -> session, once

  Request (phone -> computer): the login page shows a QR; a phone that is signed in scans it.
    POST /auth/link/request          (new device) -> token, secret, url
    POST /auth/link/peek             (anyone with the token) -> kind, status, device
    POST /auth/link/answer           (signed in, on the phone) approve / reject
    POST /auth/link/redeem           (new device) token + secret -> session, once

The QR holds the token after a '#', so it never reaches a server log. The new device's secret
never reaches page JavaScript: the web app keeps it in an httpOnly cookie. Links live 3 minutes,
nobody gets in without a yes on a device that is already signed in, and each link works once.

  GET    /auth/sessions              signed-in devices (one per sign-in)
  DELETE /auth/sessions/{family_id}  sign that device out (at once: its access token stops working too)
"""
from __future__ import annotations

import hashlib
import re
import secrets
import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.config import get_settings
from kritvia_api.deps import AnonDB, TenantDB, UserId
from kritvia_api.errors import raise_for_db
from kritvia_api.ratelimit import client_ip, limiter
from kritvia_api.routers.auth import _pair
from kritvia_api.schemas import TokenOut
from kritvia_api.services.security_log import security_event

router = APIRouter(prefix="/auth", tags=["auth"])
TOKEN = r"^[A-Za-z0-9_-]{32,64}$"


def _h(kind: str, value: str) -> str:
    return hashlib.sha256(f"device-link|{kind}|{value}".encode()).hexdigest()


def device_label(ua: str | None) -> str:
    """'Chrome on Android' from a user-agent string; good enough to recognise your own device."""
    ua = ua or ""
    if re.search(r"iPhone", ua):
        os_ = "iPhone"
    elif re.search(r"iPad", ua):
        os_ = "iPad"
    elif "Android" in ua:
        os_ = "Android"
    elif "CrOS" in ua:
        os_ = "Chromebook"
    elif "Windows" in ua:
        os_ = "Windows"
    elif "Macintosh" in ua or "Mac OS X" in ua:
        os_ = "Mac"
    elif "Linux" in ua:
        os_ = "Linux"
    else:
        os_ = "a device"
    if "Kritvia" in ua or "Electron" in ua:
        app = "Kritvia desktop app"
    elif "Edg/" in ua or "EdgA/" in ua or "EdgiOS/" in ua:
        app = "Edge"
    elif "SamsungBrowser" in ua:
        app = "Samsung Internet"
    elif "OPR/" in ua or "Opera" in ua:
        app = "Opera"
    elif "Firefox/" in ua or "FxiOS/" in ua:
        app = "Firefox"
    elif "CriOS/" in ua or "Chrome/" in ua:
        app = "Chrome"
    elif "Safari/" in ua:
        app = "Safari"
    else:
        app = "a browser"
    if os_ == "a device":
        return "Unknown device" if app == "a browser" else app
    return f"{app} on {os_}"


def _url(token: str) -> str:
    return f"{get_settings().public_web_url.rstrip('/')}/link#{token}"


async def _limit(request: Request, what: str, per_minute: int) -> None:
    await limiter.hit(f"link-{what}:{client_ip(request)}", per_minute=per_minute)


# ---------------------------------------------------------------- offer: computer -> phone --
class OfferOut(BaseModel):
    id: uuid.UUID
    token: str
    url: str = Field(description="what the QR code holds")
    expires_at: datetime


class LinkStateOut(BaseModel):
    status: Literal["waiting", "claimed", "approved", "rejected", "used", "expired"]
    device: str | None = Field(description="the device that scanned the code")
    expires_at: datetime


class DecideIn(BaseModel):
    approve: bool


@router.post("/link/offer", response_model=OfferOut, status_code=201)
async def offer(user_id: UserId, db: TenantDB, request: Request) -> OfferOut:
    await limiter.hit(f"link-offer:{user_id}", per_minute=6)
    token = secrets.token_urlsafe(32)
    try:
        r = (await db.execute(text("SELECT * FROM auth_link_offer(:t, :d)"),
                              {"t": _h("token", token), "d": device_label(request.headers.get("user-agent"))})).first()
    except DBAPIError as exc:
        raise_for_db(exc)
        raise
    return OfferOut(id=r.id, token=token, url=_url(token), expires_at=r.expires_at)


@router.get("/link/{link_id}", response_model=LinkStateOut)
async def link_state(link_id: uuid.UUID, user_id: UserId, db: TenantDB) -> LinkStateOut:
    r = (await db.execute(text("SELECT * FROM auth_link_get(:i)"), {"i": link_id})).first()
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such QR code")
    return LinkStateOut(status=r.status, device=r.device, expires_at=r.expires_at)


@router.post("/link/{link_id}/decide", response_model=LinkStateOut)
async def decide(link_id: uuid.UUID, body: DecideIn, user_id: UserId, db: TenantDB, request: Request) -> LinkStateOut:
    done = (await db.execute(text("SELECT auth_link_decide(:i, :a)"), {"i": link_id, "a": body.approve})).scalar()
    r = (await db.execute(text("SELECT * FROM auth_link_get(:i)"), {"i": link_id})).first()
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such QR code")
    if done is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "this QR code has expired or was already answered")
    if body.approve:
        await security_event("auth.device_link_approved", "info", request=request, user_id=user_id,
                             device=r.device, how="offer")
    return LinkStateOut(status=r.status, device=r.device, expires_at=r.expires_at)


class TokenIn(BaseModel):
    token: str = Field(pattern=TOKEN)


class ClaimOut(BaseModel):
    secret: str = Field(description="kept by the web app in an httpOnly cookie, never shown to the page")
    device: str


@router.post("/link/claim", response_model=ClaimOut)
async def claim(body: TokenIn, db: AnonDB, request: Request) -> ClaimOut:
    await _limit(request, "claim", 10)
    secret = secrets.token_urlsafe(32)
    device = device_label(request.headers.get("user-agent"))
    ok = (await db.execute(text("SELECT auth_link_claim(:t, :s, :d)"),
                           {"t": _h("token", body.token), "s": _h("secret", secret), "d": device})).scalar()
    if not ok:
        raise HTTPException(status.HTTP_410_GONE, "this QR code has expired or was already used; make a new one")
    return ClaimOut(secret=secret, device=device)


# ------------------------------------------------------------- request: phone -> computer --
class RequestOut(BaseModel):
    token: str
    secret: str = Field(description="kept by the web app in an httpOnly cookie, never shown to the page")
    url: str = Field(description="what the QR code holds")
    expires_at: datetime


@router.post("/link/request", response_model=RequestOut, status_code=201)
async def request_link(db: AnonDB, request: Request) -> RequestOut:
    await _limit(request, "request", 6)
    token, secret = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    exp = (await db.execute(text("SELECT auth_link_request(:t, :s, :d)"),
                            {"t": _h("token", token), "s": _h("secret", secret),
                             "d": device_label(request.headers.get("user-agent"))})).scalar_one()
    return RequestOut(token=token, secret=secret, url=_url(token), expires_at=exp)


class PeekOut(BaseModel):
    kind: Literal["offer", "request"]
    status: str
    device: str | None = Field(description="offer: the device showing the code; request: the device asking to sign in")
    expires_at: datetime


@router.post("/link/peek", response_model=PeekOut)
async def peek(body: TokenIn, db: AnonDB, request: Request) -> PeekOut:
    await _limit(request, "peek", 20)
    r = (await db.execute(text("SELECT * FROM auth_link_peek(:t)"), {"t": _h("token", body.token)})).first()
    if r is None:
        raise HTTPException(status.HTTP_410_GONE, "this QR code has expired or was already used; make a new one")
    return PeekOut(kind=r.kind, status=r.status, device=r.device, expires_at=r.expires_at)


class LinkAnswerIn(TokenIn):
    approve: bool


class LinkAnswerOut(BaseModel):
    status: Literal["approved", "rejected"]


@router.post("/link/answer", response_model=LinkAnswerOut)
async def answer(body: LinkAnswerIn, user_id: UserId, db: TenantDB, request: Request) -> LinkAnswerOut:
    await limiter.hit(f"link-answer:{user_id}", per_minute=10)
    peeked = (await db.execute(text("SELECT * FROM auth_link_peek(:t)"), {"t": _h("token", body.token)})).first()
    st = (await db.execute(text("SELECT auth_link_answer(:t, :a, :d)"),
                           {"t": _h("token", body.token), "a": body.approve,
                            "d": device_label(request.headers.get("user-agent"))})).scalar()
    if st is None:
        raise HTTPException(status.HTTP_410_GONE, "this QR code has expired or was already used; make a new one")
    if body.approve:
        await security_event("auth.device_link_approved", "info", request=request, user_id=user_id,
                             device=peeked.device if peeked else None, how="request")
    return LinkAnswerOut(status=st)


# --------------------------------------------------------------------- the new device --
class RedeemIn(TokenIn):
    secret: str = Field(pattern=TOKEN)


@router.post("/link/redeem", response_model=TokenOut,
             responses={202: {"description": "still waiting for a yes"}, 403: {"description": "refused"},
                        410: {"description": "expired or already used"}})
async def redeem(body: RedeemIn, db: AnonDB, request: Request) -> TokenOut | Response:
    await _limit(request, "redeem", 60)
    r = (await db.execute(text("SELECT * FROM auth_link_redeem(:t, :s)"),
                          {"t": _h("token", body.token), "s": _h("secret", body.secret)})).first()
    if r.status in ("waiting", "claimed"):
        return Response(status_code=status.HTTP_202_ACCEPTED, content='{"status":"waiting"}',
                        media_type="application/json")
    if r.status == "rejected":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "the sign-in was refused on your other device")
    if r.status != "used" or r.user_id is None:
        raise HTTPException(status.HTTP_410_GONE, "this QR code has expired or was already used; make a new one")
    await security_event("auth.device_link_signin", "info", request=request, user_id=r.user_id,
                         device=device_label(request.headers.get("user-agent")))
    return await _pair(db, r.user_id, request)


# ------------------------------------------------------------------ signed-in devices --
class SessionOut(BaseModel):
    id: uuid.UUID
    device: str
    signed_in_at: datetime
    last_seen_at: datetime
    this_device: bool = Field(description="best guess: the same browser as this request, most recently seen")


@router.get("/sessions", response_model=list[SessionOut])
async def sessions(user_id: UserId, db: TenantDB, request: Request) -> list[SessionOut]:
    rows = (await db.execute(text("SELECT * FROM auth_my_sessions()"))).all()
    ua = request.headers.get("user-agent") or ""
    mine = next((r.family_id for r in rows if ua and r.user_agent == ua[:200]), None)
    return [SessionOut(id=r.family_id, device=device_label(r.user_agent), signed_in_at=r.signed_in_at,
                       last_seen_at=r.last_seen_at, this_device=r.family_id == mine) for r in rows]


@router.delete("/sessions/{family_id}", status_code=204)
async def end_session(family_id: uuid.UUID, user_id: UserId, db: TenantDB, request: Request) -> None:
    if not (await db.execute(text("SELECT auth_end_session(:f)"), {"f": family_id})).scalar():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such signed-in device")
    await security_event("auth.session_ended", "info", request=request, user_id=user_id)
