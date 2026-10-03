"""Authentication: short-lived access JWTs + rotating refresh tokens.

Refresh tokens are random, stored only as SHA-256 hashes, rotated on every use,
and grouped in families: presenting a used token revokes the whole family
(stolen-token detection). Login and registration are rate-limited per IP and
per email.
"""
import hashlib
import hmac
import secrets
import uuid
from datetime import UTC, datetime, timedelta

import jwt
from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError

from kritvia_api.config import get_settings
from kritvia_api.db.session import tenant_tx
from kritvia_api.deps import AnonDB, Svc, TenantDB, UserId
from kritvia_api.errors import raise_for_db
from kritvia_api.ratelimit import client_ip, limiter
from kritvia_api.schemas import (
    EmailStartIn,
    EmailStartOut,
    EmailVerifyIn,
    GoogleSigninCompleteIn,
    GoogleSigninStartIn,
    LoginIn,
    MeOut,
    PasswordIn,
    RefreshIn,
    RegisterIn,
    SigninUrlOut,
    TokenOut,
)
from kritvia_api.services.google import GoogleError
from kritvia_api.services.mailer import MailError, get_mailer
from kritvia_api.security import hash_password, issue_access_token, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def _pair(db, user_id, request: Request) -> TokenOut:
    s = get_settings()
    refresh = secrets.token_urlsafe(48)
    await db.execute(text("SELECT auth_issue_refresh(:u, :h, :d, :a)"),
                     {"u": user_id, "h": _hash(refresh), "d": s.refresh_token_days,
                      "a": request.headers.get("user-agent", "")[:200]})
    return TokenOut(access_token=issue_access_token(user_id), expires_in=s.access_token_minutes * 60,
                    refresh_token=refresh)


async def _limit(request: Request, email: str | None = None) -> None:
    per = get_settings().auth_rate_limit_per_minute
    await limiter.hit(f"auth-ip:{client_ip(request)}", per_minute=per * 3)
    if email:
        await limiter.hit(f"auth-email:{email.lower()}", per_minute=per)


@router.post("/register", response_model=TokenOut, status_code=201)
async def register(body: RegisterIn, db: AnonDB, request: Request) -> TokenOut:
    await _limit(request, body.email)
    if not get_settings().signup_open:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "sign-up is closed on this server")
    try:
        async with db.begin_nested():
            uid = (await db.execute(
                text("SELECT auth_register(:e, :n, :h)"),
                {"e": body.email, "n": body.full_name, "h": hash_password(body.password)},
            )).scalar_one()
    except IntegrityError:
        raise HTTPException(status.HTTP_409_CONFLICT, "email already registered") from None
    return await _pair(db, uid, request)


@router.post("/login", response_model=TokenOut)
async def login(body: LoginIn, db: AnonDB, request: Request) -> TokenOut:
    await _limit(request, body.email)
    row = (await db.execute(text("SELECT * FROM auth_lookup(:e)"), {"e": body.email})).first()
    ok = verify_password(body.password, row.password_hash if row else None)
    if not ok or row is None or not row.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid credentials")
    return await _pair(db, row.id, request)


@router.post("/refresh", response_model=TokenOut)
async def refresh(body: RefreshIn, request: Request) -> TokenOut:
    await _limit(request)
    s = get_settings()
    new = secrets.token_urlsafe(48)
    # Own transaction: a reuse-detection revocation must commit even though we answer 401.
    async with tenant_tx(None) as db:
        uid = (await db.execute(text("SELECT auth_rotate_refresh(:h, :n, :d)"),
                                {"h": _hash(body.refresh_token), "n": _hash(new), "d": s.refresh_token_days})).scalar()
    if uid is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "refresh token invalid, expired or reused")
    return TokenOut(access_token=issue_access_token(uid), expires_in=s.access_token_minutes * 60, refresh_token=new)


@router.post("/logout", status_code=204)
async def logout(body: RefreshIn, db: AnonDB) -> None:
    await db.execute(text("SELECT auth_revoke_refresh(:h)"), {"h": _hash(body.refresh_token)})


@router.get("/me", response_model=MeOut)
async def me(user_id: UserId, db: TenantDB) -> MeOut:
    row = (await db.execute(
        text("SELECT id, email, full_name FROM users WHERE id = :u"), {"u": user_id}
    )).first()
    if row is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "user no longer exists")
    return MeOut(id=row.id, email=row.email, full_name=row.full_name)


@router.post("/password", response_model=TokenOut)
async def change_password(body: PasswordIn, user_id: UserId, db: TenantDB, request: Request) -> TokenOut:
    """Changes the password, signs out every session (refresh tokens revoked, older access
    tokens rejected) and returns a fresh pair for the current one."""
    await _limit(request, str(user_id))
    row = (await db.execute(text("SELECT email FROM users WHERE id = :u"), {"u": user_id})).first()
    cur = (await db.execute(text("SELECT * FROM auth_lookup(:e)"), {"e": row.email})).first()
    if not verify_password(body.current_password, cur.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "current password is wrong")
    await db.execute(text("SELECT auth_set_password(:h)"), {"h": hash_password(body.new_password)})
    return await _pair(db, user_id, request)


# --- Email code sign-in (also how new people sign up: proving the address is the signup) --
def _code_hash(email: str, code: str) -> str:
    key = get_settings().jwt_secret.encode()
    return hmac.new(key, f"email-code|{email.lower()}|{code}".encode(), hashlib.sha256).hexdigest()


async def _signup_allowed(db, email: str) -> bool:
    if get_settings().signup_open:
        return True
    return (await db.execute(text("SELECT 1 FROM auth_lookup(:e)"), {"e": email})).first() is not None


@router.post("/email/start", response_model=EmailStartOut, status_code=202)
async def email_start(body: EmailStartIn, db: AnonDB, request: Request) -> EmailStartOut:
    """Emails a 6-digit sign-in code. The answer is the same whether or not the address has
    an account, so this can't be used to find out who is registered."""
    s = get_settings()
    email = body.email.lower()
    await _limit(request, email)
    await limiter.hit(f"email-code:{email}", per_minute=3)
    mailer = get_mailer()
    if not mailer.can_deliver:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "email sign-in is not configured on this server")
    if await _signup_allowed(db, email):
        code = f"{secrets.randbelow(1_000_000):06d}"
        await db.execute(text("SELECT auth_code_issue(:e, :h, :m)"),
                         {"e": email, "h": _code_hash(email, code), "m": s.email_code_minutes})
        try:
            await mailer.send(
                email, f"{code} is your Kritvia sign-in code",
                f"Your Kritvia sign-in code is {code}\n\n"
                f"It works for {s.email_code_minutes} minutes, once. If you didn't ask for it, ignore this email.\n")
        except MailError:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, "could not send the email, try again shortly") from None
    return EmailStartOut(expires_in=s.email_code_minutes * 60)


@router.post("/email/verify", response_model=TokenOut)
async def email_verify(body: EmailVerifyIn, request: Request) -> TokenOut:
    email = body.email.lower()
    await _limit(request, email)
    # Own transaction: a wrong code must count as an attempt even though we answer 401.
    async with tenant_tx(None) as db:
        ok = (await db.execute(text("SELECT auth_code_consume(:e, :h)"),
                               {"e": email, "h": _code_hash(email, body.code)})).scalar()
    if not ok:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "that code is wrong or has expired")
    async with tenant_tx(None) as db:
        if not await _signup_allowed(db, email):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "sign-up is closed on this server")
        uid = (await db.execute(text("SELECT auth_signin_email(:e, :n)"),
                                {"e": email, "n": body.full_name.strip()})).scalar()
        if uid is None:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "this account is disabled")
        return await _pair(db, uid, request)


# --- Sign in with Google ---------------------------------------------------------------
def _signin_nonce_hash(nonce: str) -> str:
    return hashlib.sha256(("google-signin|" + nonce).encode()).hexdigest()


def _google(svc):
    if svc.google is None or not svc.google.configured:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Google sign-in is not configured on this server")
    return svc.google


@router.post("/google/start", response_model=SigninUrlOut)
async def google_signin_start(body: GoogleSigninStartIn, request: Request, svc: Svc) -> SigninUrlOut:
    await _limit(request)
    google = _google(svc)
    s = get_settings()
    state = jwt.encode({"typ": "signin", "nh": _signin_nonce_hash(body.nonce),
                        "exp": datetime.now(UTC) + timedelta(minutes=10)}, s.jwt_secret, algorithm=s.jwt_algorithm)
    return SigninUrlOut(url=google.signin_url(state))


@router.post("/google/complete", response_model=TokenOut)
async def google_signin_complete(body: GoogleSigninCompleteIn, request: Request, svc: Svc) -> TokenOut:
    """Called by the web app's OAuth callback with the code, the state and the nonce from its
    httpOnly cookie, so a sign-in link started in another browser does not work here."""
    await _limit(request)
    s = get_settings()
    try:
        st = jwt.decode(body.state, s.jwt_secret, algorithms=[s.jwt_algorithm], options={"require": ["exp", "typ"]})
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid or expired sign-in state") from None
    if st.get("typ") != "signin" or not hmac.compare_digest(st.get("nh", ""), _signin_nonce_hash(body.nonce)):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "this Google sign-in was not started in this browser")
    try:
        who = await _google(svc).signin_identity(body.code)
    except GoogleError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from None
    async with tenant_tx(None) as db:
        if not await _signup_allowed(db, who["email"]):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "sign-up is closed on this server")
        uid = (await db.execute(text("SELECT auth_signin_google(:s, :e, :n)"),
                                {"s": who["sub"], "e": who["email"], "n": who["name"]})).scalar()
        if uid is None:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "this account is disabled or linked to another Google account")
        return await _pair(db, uid, request)


# --- Your data (DPDP): export and deletion ----------------------------------------------
async def _rows(db, sql: str, params: dict) -> list[dict]:
    out = []
    for r in (await db.execute(text(sql), params)).all():
        out.append({k: (v.isoformat() if hasattr(v, "isoformat") else str(v) if isinstance(v, uuid.UUID) else v)
                    for k, v in r._mapping.items()})
    return out


@router.get("/me/export")
async def export_my_data(user_id: UserId, db: TenantDB) -> dict:
    """Everything Kritvia holds about you as a person (not your organisation's business data,
    which an owner exports per business)."""
    u = {"u": user_id}
    return {
        "exported_at": datetime.now(UTC).isoformat(),
        "profile": (await _rows(db, "SELECT id, email, full_name, created_at, email_verified_at"
                                    " FROM users WHERE id = :u", u))[0],
        "memberships": await _rows(db, "SELECT o.name AS organisation, v.name AS business, m.role, m.created_at"
                                       " FROM memberships m JOIN organisations o ON o.id = m.org_id"
                                       " LEFT JOIN ventures v ON v.id = m.venture_id WHERE m.user_id = :u", u),
        "voice_settings": await _rows(db, "SELECT engine, language, remove_fillers, profanity_filter, auto_learn,"
                                          " hotkey, widget_enabled FROM voice_settings WHERE user_id = :u", u),
        "personal_vocabulary": await _rows(db, "SELECT term, sounds_like, created_at FROM vocabulary_terms"
                                               " WHERE user_id = :u", u),
        "dictation_stats": await _rows(db, "SELECT surface, mode, engine, language, created_at"
                                           " FROM dictation_events WHERE user_id = :u ORDER BY created_at", u),
        "approval_decisions": await _rows(db, "SELECT action, status, decided_at FROM approvals"
                                              " WHERE decided_by = :u ORDER BY decided_at", u),
    }


class DeleteMeIn(BaseModel):
    confirm: str = Field(description='type "DELETE"')


@router.post("/me/delete", status_code=200)
async def delete_my_account(body: DeleteMeIn, user_id: UserId, db: TenantDB) -> dict:
    if body.confirm != "DELETE":
        raise HTTPException(422, 'type DELETE to confirm')
    try:
        async with db.begin_nested():
            closed = (await db.execute(text("SELECT delete_my_account('DELETE')"))).scalar_one()
    except DBAPIError as exc:
        raise_for_db(exc, "account not found")
    return {"deleted": True, "organisations_closed": closed}
