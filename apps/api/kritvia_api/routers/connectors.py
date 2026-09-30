"""Connectors: Google Workspace (OAuth, offline), signed inbound webhooks, Drive import."""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import time
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.config import get_settings
from kritvia_api.db.session import tenant_tx
from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.engine.runner import DuplicateTrigger, start_run
from kritvia_api.errors import raise_for_db
from kritvia_api.ratelimit import client_ip, limiter
from kritvia_api.services import memory
from kritvia_api.services.crypto import EnvelopeCrypto
from kritvia_api.services.google import GoogleError
from kritvia_api.services.messaging import load_google
from kritvia_api.workflows.lead_triage import lead_from_webhook

router = APIRouter(tags=["connectors"])
SECRET = "connector.secret"


class ConnectorOut(BaseModel):
    id: uuid.UUID
    provider: str
    account_email: str | None
    scopes: list[str]
    status: str
    cursor: str | None
    last_error: str | None
    created_at: datetime
    updated_at: datetime
    webhook_url: str | None = None


@router.get("/ventures/{venture_id}/connectors", response_model=list[ConnectorOut])
async def list_connectors(venture_id: uuid.UUID, db: TenantDB) -> list[ConnectorOut]:
    rows = (await db.execute(text(
        "SELECT id, provider, account_email, scopes, status, cursor, last_error, created_at, updated_at"
        " FROM connectors WHERE venture_id = :v ORDER BY provider"), {"v": venture_id})).all()
    base = get_settings().public_api_url
    return [ConnectorOut(**r._mapping, webhook_url=f"{base}/hooks/{r.id}" if r.provider == "webhook" else None)
            for r in rows]


async def _require_admin(db, venture_id: uuid.UUID) -> uuid.UUID:
    org = await venture_org(db, venture_id)
    if not (await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "venture not found")
    return org


@router.delete("/ventures/{venture_id}/connectors/{connector_id}", status_code=204)
async def remove_connector(venture_id: uuid.UUID, connector_id: uuid.UUID, db: TenantDB) -> None:
    await _require_admin(db, venture_id)
    try:
        async with db.begin_nested():
            res = await db.execute(text("DELETE FROM connectors WHERE venture_id = :v AND id = :id"),
                                   {"v": venture_id, "id": connector_id})
    except DBAPIError as exc:
        raise_for_db(exc, "connector not found")
    if res.rowcount == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "connector not found")


# ------------------------------------------------------------------ Google --
class AuthUrlOut(BaseModel):
    url: str


class GoogleStartIn(BaseModel):
    nonce: str = Field(min_length=32, max_length=128,
                       description="random value the web app also stores in an httpOnly cookie; binds the "
                                   "OAuth callback to the browser that started it")


def _nonce_hash(nonce: str) -> str:
    return hashlib.sha256(("google-oauth|" + nonce).encode()).hexdigest()


@router.post("/ventures/{venture_id}/connectors/google/start", response_model=AuthUrlOut)
async def google_start(venture_id: uuid.UUID, body: GoogleStartIn, user_id: UserId, db: TenantDB,
                       svc: Svc) -> AuthUrlOut:
    await _require_admin(db, venture_id)
    if svc.google is None or not svc.google.configured:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Google OAuth is not configured on this server")
    s = get_settings()
    state = jwt.encode({"typ": "oauth", "v": str(venture_id), "u": str(user_id), "nh": _nonce_hash(body.nonce),
                        "exp": datetime.now(UTC) + timedelta(minutes=10)}, s.jwt_secret, algorithm=s.jwt_algorithm)
    return AuthUrlOut(url=svc.google.authorization_url(state))


class GoogleCompleteIn(BaseModel):
    code: str = Field(min_length=1, max_length=2000)
    state: str = Field(min_length=1, max_length=4000)
    nonce: str = Field(min_length=32, max_length=128)


class GoogleCompleteOut(BaseModel):
    venture_id: uuid.UUID
    connector_id: uuid.UUID
    account_email: str | None
    scopes: list[str]


@router.post("/connectors/google/complete", response_model=GoogleCompleteOut)
async def google_complete(body: GoogleCompleteIn, user_id: UserId, svc: Svc) -> GoogleCompleteOut:
    """Called by the web app's OAuth callback route with the code, the state and the nonce
    from ITS httpOnly cookie, authenticated as the signed-in user. A consent link started
    by someone else fails here: wrong browser (no nonce) and wrong user."""
    s = get_settings()
    try:
        st = jwt.decode(body.state, s.jwt_secret, algorithms=[s.jwt_algorithm],
                        options={"require": ["exp", "typ"]})
        if st["typ"] != "oauth":
            raise jwt.InvalidTokenError()
        venture_id, state_user = uuid.UUID(st["v"]), uuid.UUID(st["u"])
    except (jwt.PyJWTError, KeyError, ValueError):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid or expired OAuth state") from None
    if state_user != user_id or not hmac.compare_digest(st.get("nh", ""), _nonce_hash(body.nonce)):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "this Google authorisation was not started in this session")
    if svc.google is None or not svc.google.configured:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Google OAuth is not configured on this server")
    try:
        tok = await svc.google.exchange_code(body.code)
    except GoogleError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from None
    granted = [sc for sc in tok["scope"].split() if sc]
    async with tenant_tx(user_id) as conn:
        org = await _require_admin(conn, venture_id)
        cid = (await conn.execute(text(
            "INSERT INTO connectors (org_id, venture_id, provider, account_email, scopes, created_by)"
            " VALUES (:o, :v, 'google', :e, :s, :u) ON CONFLICT (venture_id, provider) DO UPDATE SET"
            " account_email = EXCLUDED.account_email, scopes = EXCLUDED.scopes, status = 'active', last_error = NULL,"
            " updated_at = now() RETURNING id"),
            {"o": org, "v": venture_id, "e": tok["email"], "s": granted, "u": user_id})).scalar_one()
        enc = await EnvelopeCrypto(conn, svc.keys).encrypt(venture_id, SECRET, tok["refresh_token"])
        await conn.execute(text(
            "INSERT INTO connector_tokens (connector_id, org_id, venture_id, secret_enc) VALUES (:c, :o, :v, :s)"
            " ON CONFLICT (connector_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, updated_at = now()"),
            {"c": cid, "o": org, "v": venture_id, "s": enc})
    return GoogleCompleteOut(venture_id=venture_id, connector_id=cid, account_email=tok["email"], scopes=granted)


class SyncOut(BaseModel):
    started: dict[str, int]


@router.post("/ventures/{venture_id}/connectors/google/sync", response_model=SyncOut)
async def google_sync(venture_id: uuid.UUID, db: TenantDB, svc: Svc) -> SyncOut:
    """Poll Gmail now instead of waiting for the 5-minute schedule."""
    from kritvia_api.services.pollers import poll_gmail_venture
    org = await _require_admin(db, venture_id)
    run_as = (await db.execute(text("SELECT venture_service_account(:v)"), {"v": venture_id})).scalar_one()
    try:
        return SyncOut(started=await poll_gmail_venture(svc, org, venture_id, run_as))
    except GoogleError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from None


class DriveImportIn(BaseModel):
    query: str = Field(default="trashed = false and (mimeType contains 'document' or mimeType = 'application/pdf')",
                       max_length=500)
    max_files: int = Field(default=20, ge=1, le=100)


class DriveImportOut(BaseModel):
    imported: int
    skipped: int
    warnings: list[str]


@router.post("/ventures/{venture_id}/connectors/google/drive-import", response_model=DriveImportOut)
async def drive_import(venture_id: uuid.UUID, body: DriveImportIn, user_id: UserId, svc: Svc) -> DriveImportOut:
    """Pull Drive files (proposals, SOPs, templates) into the knowledge base."""
    async with tenant_tx(user_id) as db:
        org = await _require_admin(db, venture_id)
        run_as = (await db.execute(text("SELECT venture_service_account(:v)"), {"v": venture_id})).scalar_one()
    from kritvia_api.engine.context import RunContext
    ctx = RunContext(run_id=uuid.uuid4(), org_id=org, venture_id=venture_id, run_as=run_as, workflow="drive_import",
                     services=svc, agent="drive_import")
    async with ctx.tx() as conn:
        g = await load_google(ctx, conn)
    if g is None or svc.google is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "connect Google first")
    token = await svc.google.access_token(g.id, g.refresh_token)
    files = await svc.google.list_drive_files(token, body.query, body.max_files)
    imported = skipped = 0
    warnings: list[str] = []
    actor = memory.UserActor(user_id, org, venture_id, svc.router, svc.keys, workflow="drive_import")
    for f in files:
        try:
            data, mime = await svc.google.download_drive_file(token, f)
            ext = {"text/plain": ".txt", "text/csv": ".csv", "application/pdf": ".pdf"}.get(mime, "")
            res = await memory.ingest(actor, title=f["name"], kind="drive", data=data, filename=f["name"] + ext,
                                      mime=mime, source_uri=f.get("webViewLink"), external_id=f["id"],
                                      created_by=user_id)
            imported += 0 if res.duplicate else 1
            skipped += 1 if res.duplicate else 0
        except Exception as exc:
            warnings.append(f"{f.get('name')}: {type(exc).__name__}")
    return DriveImportOut(imported=imported, skipped=skipped, warnings=warnings[:50])


# ----------------------------------------------------------------- webhooks --
class WebhookOut(BaseModel):
    connector_id: uuid.UUID
    url: str
    secret: str = Field(description="shown once — store it in the sending system")


@router.post("/ventures/{venture_id}/connectors/webhook", response_model=WebhookOut, status_code=201)
async def create_webhook(venture_id: uuid.UUID, user_id: UserId, db: TenantDB, svc: Svc) -> WebhookOut:
    """Lead-form webhook. Rotates the secret if one already exists."""
    org = await _require_admin(db, venture_id)
    secret = "whsec_" + secrets.token_urlsafe(32)
    try:
        async with db.begin_nested():
            cid = (await db.execute(text(
                "INSERT INTO connectors (org_id, venture_id, provider, created_by) VALUES (:o, :v, 'webhook', :u)"
                " ON CONFLICT (venture_id, provider) DO UPDATE SET status = 'active', updated_at = now()"
                " RETURNING id"), {"o": org, "v": venture_id, "u": user_id})).scalar_one()
            enc = await EnvelopeCrypto(db, svc.keys).encrypt(venture_id, SECRET, secret)
            await db.execute(text(
                "INSERT INTO connector_tokens (connector_id, org_id, venture_id, secret_enc) VALUES (:c, :o, :v, :s)"
                " ON CONFLICT (connector_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, updated_at = now()"),
                {"c": cid, "o": org, "v": venture_id, "s": enc})
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    return WebhookOut(connector_id=cid, url=f"{get_settings().public_api_url}/hooks/{cid}", secret=secret)


def sign(secret: str, timestamp: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()


class HookOut(BaseModel):
    accepted: bool
    run_id: uuid.UUID | None = None
    duplicate: bool = False


@router.post("/hooks/{connector_id}", response_model=HookOut, status_code=202)
async def inbound_hook(connector_id: uuid.UUID, request: Request, svc: Svc) -> HookOut:
    """Signed lead-form webhook.

    Server-to-server senders sign: X-Kritvia-Timestamp (unix seconds) and
    X-Kritvia-Signature = sha256=HMAC(secret, "<timestamp>.<raw body>"); requests
    older than 5 minutes are refused. No-code tools that cannot sign may send the
    secret itself in X-Kritvia-Key (keep such senders server-side)."""
    await limiter.hit(f"hook:{connector_id}", per_minute=60)
    await limiter.hit(f"hook-ip:{client_ip(request)}", per_minute=120)
    body = await request.body()
    if len(body) > 64 * 1024:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "payload too large")
    async with tenant_tx(None, "system") as conn:
        p = (await conn.execute(text("SELECT * FROM private.webhook_principal(:c)"), {"c": connector_id})).first()
    if p is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown webhook")
    async with tenant_tx(p.run_as, "agent", "webhook") as conn:
        enc = (await conn.execute(text("SELECT secret_enc FROM connector_tokens WHERE connector_id = :c"),
                                  {"c": connector_id})).scalar()
        secret = await EnvelopeCrypto(conn, svc.keys).decrypt_str(p.venture_id, SECRET, enc) if enc else None
    if not secret:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown webhook")
    ts, sig, key = (request.headers.get("x-kritvia-timestamp"), request.headers.get("x-kritvia-signature"),
                    request.headers.get("x-kritvia-key"))
    if sig and ts:
        if not ts.isdigit() or abs(time.time() - int(ts)) > 300:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "stale or invalid timestamp")
        if not hmac.compare_digest(sig, sign(secret, ts, body)):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad signature")
    elif not (key and hmac.compare_digest(key, secret)):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing signature")
    try:
        payload: dict[str, Any] = json.loads(body or b"{}")
        if not isinstance(payload, dict):
            raise ValueError
    except ValueError:
        raise HTTPException(422, "body must be a JSON object") from None
    lead = lead_from_webhook(payload)
    if not (lead["body"] or lead["from_email"]):
        raise HTTPException(422, "payload has no message or email")
    try:
        run_id = await start_run(svc, actor_user_id=p.run_as, actor_type="agent", venture_id=p.venture_id,
                                 workflow="lead_triage", input=lead, trigger_kind="webhook",
                                 dedupe=("webhook", hashlib.sha256(body).hexdigest()),
                                 title=f"Web form: {lead.get('company') or lead.get('from_name') or 'lead'}")
    except DuplicateTrigger:
        return HookOut(accepted=True, duplicate=True)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    return HookOut(accepted=True, run_id=run_id)

