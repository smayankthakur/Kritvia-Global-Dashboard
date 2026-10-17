"""Single sign-on (Enterprise): an organisation's own identity provider over OpenID Connect.

  GET    /orgs/{org_id}/sso          the settings (owners; never the client secret)
  PUT    /orgs/{org_id}/sso          save them (the plan must include SSO)
  POST   /orgs/{org_id}/sso/verify   check the DNS TXT record that proves the domain
  DELETE /orgs/{org_id}/sso          remove SSO
  POST   /auth/sso/start             {email, nonce} -> the provider's sign-in page
  POST   /auth/sso/complete          {code, state, nonce} -> signed in (web app's callback only)
"""
from __future__ import annotations

import hmac
import uuid
from datetime import UTC, datetime, timedelta

import jwt
from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.config import get_settings
from kritvia_api.db.session import tenant_tx
from kritvia_api.deps import Svc, TenantDB, UserId
from kritvia_api.errors import raise_for_db
from kritvia_api.plans import plan as plan_of
from kritvia_api.schemas import SigninUrlOut, TokenOut
from kritvia_api.services import sso
from kritvia_api.services.security_log import security_event

router = APIRouter(tags=["sso"])
DOMAIN_RE = r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$"


class SsoOut(BaseModel):
    available: bool = Field(description="the organisation's plan includes single sign-on")
    configured: bool
    domain: str | None = None
    issuer: str | None = None
    client_id: str | None = None
    verified: bool = False
    txt_name: str | None = Field(None, description="DNS TXT record to add, to prove the domain")
    txt_value: str | None = None
    enabled: bool = False
    enforce: bool = False
    owner_tested: bool = Field(False, description="an owner has signed in through SSO since the last change")
    last_signin_at: datetime | None = None
    redirect_uri: str = Field(description="the redirect (callback) URL to register with the identity provider")


class SsoIn(BaseModel):
    domain: str = Field(min_length=3, max_length=200, pattern=DOMAIN_RE)
    issuer: str = Field(min_length=9, max_length=300, pattern=r"^https://")
    client_id: str = Field(min_length=1, max_length=300)
    client_secret: str | None = Field(None, min_length=1, max_length=2000,
                                      description="leave out to keep the saved one")
    enabled: bool = True
    enforce: bool = False


class SsoStartIn(BaseModel):
    email: EmailStr
    nonce: str = Field(min_length=32, max_length=128)


class SsoCompleteIn(BaseModel):
    code: str = Field(min_length=1, max_length=4000)
    state: str = Field(min_length=1, max_length=4000)
    nonce: str = Field(min_length=32, max_length=128)


async def _owner(db, org_id: uuid.UUID) -> None:
    if not (await db.execute(text("SELECT :o = ANY (private.owned_orgs())"), {"o": org_id})).scalar():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "organisation not found")


async def _available(db, org_id: uuid.UUID) -> bool:
    code = (await db.execute(text("SELECT plan FROM org_plan_state(:o)"), {"o": org_id})).scalar()
    return "sso" in plan_of(code).extras


async def _out(db, org_id: uuid.UUID) -> SsoOut:
    r = (await db.execute(text(
        "SELECT domain, issuer, client_id, verify_token, verified_at, enabled, enforce, owner_tested_at, last_signin_at"
        " FROM sso_configs WHERE org_id = :o"), {"o": org_id})).first()
    base = {"available": await _available(db, org_id), "redirect_uri": sso.redirect_uri()}
    if r is None:
        return SsoOut(configured=False, **base)
    return SsoOut(configured=True, domain=r.domain, issuer=r.issuer, client_id=r.client_id,
                  verified=r.verified_at is not None, txt_name=sso.txt_name(r.domain), txt_value=sso.txt_value(r.verify_token),
                  enabled=r.enabled, enforce=r.enforce, owner_tested=r.owner_tested_at is not None,
                  last_signin_at=r.last_signin_at, **base)


@router.get("/orgs/{org_id}/sso", response_model=SsoOut)
async def get_sso(org_id: uuid.UUID, db: TenantDB) -> SsoOut:
    await _owner(db, org_id)
    return await _out(db, org_id)


@router.put("/orgs/{org_id}/sso", response_model=SsoOut)
async def save_sso(org_id: uuid.UUID, body: SsoIn, user_id: UserId, db: TenantDB, svc: Svc, request: Request) -> SsoOut:
    await _owner(db, org_id)
    if not await _available(db, org_id):
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, "single sign-on is part of the Enterprise plan")
    issuer = sso.normal_issuer(body.issuer)
    try:
        await sso.discover(issuer)
    except sso.SsoError as exc:
        raise HTTPException(422, f"couldn't use that issuer: {exc}") from None
    wrapped = svc.keys.wrap(body.client_secret.strip().encode(), sso.secret_context(org_id)) if body.client_secret else None
    try:
        async with db.begin_nested():
            await db.execute(text("SELECT private.sso_save(:o, :d, :i, :c, :w, :t, :e, :f)"),
                             {"o": org_id, "d": body.domain.lower(), "i": issuer, "c": body.client_id.strip(),
                              "w": wrapped, "t": sso.new_verify_token(), "e": body.enabled, "f": body.enforce})
    except DBAPIError as exc:
        raise_for_db(exc, "organisation not found")
        raise
    await security_event("sso.saved", "info", request=request, user_id=user_id, org_id=org_id,
                         enforce=body.enforce, enabled=body.enabled)
    return await _out(db, org_id)


@router.post("/orgs/{org_id}/sso/verify", response_model=SsoOut)
async def verify_sso(org_id: uuid.UUID, user_id: UserId, db: TenantDB, request: Request) -> SsoOut:
    await _owner(db, org_id)
    r = (await db.execute(text("SELECT domain, verify_token FROM sso_configs WHERE org_id = :o"), {"o": org_id})).first()
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "set up SSO first")
    try:
        found = await sso.txt_records(sso.txt_name(r.domain))
    except sso.SsoError as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from None
    if sso.txt_value(r.verify_token) not in found:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            f"the TXT record {sso.txt_name(r.domain)} wasn't found yet (DNS changes can take an hour)")
    await db.execute(text("SELECT private.sso_mark_verified(:o)"), {"o": org_id})
    await security_event("sso.domain_verified", "info", request=request, user_id=user_id, org_id=org_id)
    return await _out(db, org_id)


@router.delete("/orgs/{org_id}/sso", status_code=204)
async def delete_sso(org_id: uuid.UUID, user_id: UserId, db: TenantDB, request: Request) -> None:
    await _owner(db, org_id)
    if not (await db.execute(text("SELECT private.sso_delete(:o)"), {"o": org_id})).scalar():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "SSO isn't set up")
    await security_event("sso.removed", "info", request=request, user_id=user_id, org_id=org_id)


# ------------------------------------------------------------------------------ sign in --
async def _config(domain: str):
    async with tenant_tx(None) as db:
        r = (await db.execute(text("SELECT * FROM sso_for_domain(:d)"), {"d": domain})).first()
    if r is None or "sso" not in plan_of(r.plan or None).extras:
        return None
    return r


@router.post("/auth/sso/start", response_model=SigninUrlOut)
async def sso_start(body: SsoStartIn, request: Request) -> SigninUrlOut:
    from kritvia_api.routers.auth import _limit
    await _limit(request)
    domain = sso.domain_of(body.email)
    cfg = await _config(domain)
    if cfg is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "single sign-on isn't set up for this email domain")
    s = get_settings()
    state = jwt.encode({"typ": "sso", "org": str(cfg.org_id), "d": domain, "nh": sso.nonce_hash(body.nonce),
                        "exp": datetime.now(UTC) + timedelta(minutes=10)}, s.jwt_secret, algorithm=s.jwt_algorithm)
    try:
        return SigninUrlOut(url=await sso.signin_url(cfg.issuer, cfg.client_id, state, body.nonce))
    except sso.SsoError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from None


@router.post("/auth/sso/complete", response_model=TokenOut)
async def sso_complete(body: SsoCompleteIn, request: Request, svc: Svc) -> TokenOut:
    from kritvia_api.routers.auth import _pair, _limit
    await _limit(request)
    s = get_settings()
    try:
        st = jwt.decode(body.state, s.jwt_secret, algorithms=[s.jwt_algorithm], options={"require": ["exp", "typ"]})
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid or expired sign-in state") from None
    if st.get("typ") != "sso" or not hmac.compare_digest(str(st.get("nh", "")), sso.nonce_hash(body.nonce)):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "this sign-in was not started in this browser")
    cfg = await _config(str(st.get("d", "")))
    if cfg is None or str(cfg.org_id) != st.get("org"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "single sign-on is no longer set up for this organisation")
    secret = svc.keys.unwrap(cfg.secret_wrapped, sso.secret_context(cfg.org_id)).decode()
    try:
        who = await sso.identity(cfg.issuer, cfg.client_id, secret, body.code, body.nonce, st["d"])
    except sso.SsoError as exc:
        await security_event("auth.sso_failed", "warning", request=request, org_id=cfg.org_id, reason=str(exc)[:200])
        raise HTTPException(status.HTTP_403_FORBIDDEN, str(exc)) from None
    async with tenant_tx(None) as db:
        uid = (await db.execute(text("SELECT auth_signin_sso(:o, :e, :n)"),
                                {"o": cfg.org_id, "e": who["email"], "n": who["name"]})).scalar()
        if uid is None:
            raise HTTPException(status.HTTP_403_FORBIDDEN,
                                "you don't have a Kritvia account yet: ask your organisation's owner to invite you")
        await security_event("auth.sso_signin", "info", request=request, user_id=uid, org_id=cfg.org_id)
        return await _pair(db, uid, request)
