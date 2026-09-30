"""Authentication: short-lived access JWTs + rotating refresh tokens.

Refresh tokens are random, stored only as SHA-256 hashes, rotated on every use,
and grouped in families: presenting a used token revokes the whole family
(stolen-token detection). Login and registration are rate-limited per IP and
per email.
"""
import hashlib
import secrets

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from kritvia_api.config import get_settings
from kritvia_api.db.session import tenant_tx
from kritvia_api.deps import AnonDB, TenantDB, UserId
from kritvia_api.ratelimit import client_ip, limiter
from kritvia_api.schemas import LoginIn, MeOut, PasswordIn, RefreshIn, RegisterIn, TokenOut
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
