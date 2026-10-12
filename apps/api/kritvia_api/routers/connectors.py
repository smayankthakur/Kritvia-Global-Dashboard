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
from kritvia_api.services.security_log import security_event
from kritvia_api.ratelimit import client_ip, limiter
from kritvia_api.services import memory, push, wa_inbox
from kritvia_api.services.crypto import EnvelopeCrypto
from kritvia_api.services.google import GoogleError
from kritvia_api.services.messaging import load_google
from kritvia_api.workflows.lead_triage import lead_from_webhook
from kritvia_api.services.quota import PlanRestricted, plan_for_venture, require_integration

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
    from kritvia_api.services.google import DEFAULT_SCOPES, SEND_ONLY_SCOPES
    read_plans = {p.strip() for p in s.google_read_plans.split(",") if p.strip()}
    plan = await plan_for_venture(db, venture_id)
    scopes = DEFAULT_SCOPES if plan.code in read_plans else SEND_ONLY_SCOPES
    state = jwt.encode({"typ": "oauth", "v": str(venture_id), "u": str(user_id), "nh": _nonce_hash(body.nonce),
                        "exp": datetime.now(UTC) + timedelta(minutes=10)}, s.jwt_secret, algorithm=s.jwt_algorithm)
    return AuthUrlOut(url=svc.google.authorization_url(state, scopes))


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
        await require_integration(db, venture_id, "drive")
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


class PickerConfigOut(BaseModel):
    ready: bool
    client_id: str = ""
    api_key: str = ""
    app_id: str = ""
    account_email: str | None = None
    full_drive: bool = Field(default=False, description="this connection can read all of Drive (older connections)")


@router.get("/ventures/{venture_id}/connectors/google/picker", response_model=PickerConfigOut)
async def picker_config(venture_id: uuid.UUID, db: TenantDB) -> PickerConfigOut:
    """What the browser needs to open Google's file picker (public values; no secrets)."""
    from kritvia_api.services.google import SCOPES
    await _require_admin(db, venture_id)
    s = get_settings()
    row = (await db.execute(text("SELECT account_email, scopes FROM connectors WHERE venture_id = :v"
                                 " AND provider = 'google' AND status = 'active'"), {"v": venture_id})).first()
    ready = bool(row and SCOPES["drive.file"] in row.scopes and s.google_client_id and s.google_picker_api_key
                 and s.google_app_id)
    return PickerConfigOut(ready=ready, client_id=s.google_client_id if ready else "",
                           api_key=s.google_picker_api_key if ready else "", app_id=s.google_app_id if ready else "",
                           account_email=row.account_email if row else None,
                           full_drive=bool(row and SCOPES["drive.readonly"] in row.scopes))


class DrivePickedIn(BaseModel):
    file_ids: list[str] = Field(min_length=1, max_length=50)


@router.post("/ventures/{venture_id}/connectors/google/drive-picked", response_model=DriveImportOut)
async def drive_picked(venture_id: uuid.UUID, body: DrivePickedIn, user_id: UserId, svc: Svc) -> DriveImportOut:
    """Adds the Drive files the person chose in Google's picker to business memory."""
    import re as _re
    if any(not _re.fullmatch(r"[A-Za-z0-9_-]{10,200}", f) for f in body.file_ids):
        raise HTTPException(422, "invalid Drive file id")
    async with tenant_tx(user_id) as db:
        org = await _require_admin(db, venture_id)
        await require_integration(db, venture_id, "drive")
        run_as = (await db.execute(text("SELECT venture_service_account(:v)"), {"v": venture_id})).scalar_one()
    from kritvia_api.engine.context import RunContext
    ctx = RunContext(run_id=uuid.uuid4(), org_id=org, venture_id=venture_id, run_as=run_as, workflow="drive_import",
                     services=svc, agent="drive_import")
    async with ctx.tx() as conn:
        g = await load_google(ctx, conn)
    if g is None or svc.google is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "connect Google first")
    token = await svc.google.access_token(g.id, g.refresh_token)
    imported = skipped = 0
    warnings: list[str] = []
    actor = memory.UserActor(user_id, org, venture_id, svc.router, svc.keys, workflow="drive_import")
    for fid in dict.fromkeys(body.file_ids):
        try:
            f = await svc.google.get_drive_file(token, fid)
            if f.get("trashed"):
                skipped += 1
                continue
            data, mime = await svc.google.download_drive_file(token, f)
            ext = {"text/plain": ".txt", "text/csv": ".csv", "application/pdf": ".pdf"}.get(mime, "")
            res = await memory.ingest(actor, title=f["name"], kind="drive", data=data, filename=f["name"] + ext,
                                      mime=mime, source_uri=f.get("webViewLink"), external_id=f["id"],
                                      created_by=user_id)
            imported += 0 if res.duplicate else 1
            skipped += 1 if res.duplicate else 0
        except Exception as exc:
            warnings.append(f"{fid}: {type(exc).__name__}")
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


# ----------------------------------------------------------------- whatsapp --
class WhatsAppConnectIn(BaseModel):
    phone_number_id: str = Field(min_length=5, max_length=40, pattern=r"^\d+$",
                                 description="from Meta → WhatsApp → API setup")
    access_token: str = Field(min_length=20, max_length=1000, description="permanent system-user token")
    waba_id: str | None = Field(default=None, min_length=5, max_length=40, pattern=r"^\d+$",
                                description="WhatsApp Business Account id; needed to write templates in Kritvia")


class WhatsAppConnectOut(BaseModel):
    connector_id: uuid.UUID
    display_phone_number: str | None = None
    verified_name: str | None = None
    webhook_url: str
    webhook_ready: bool = Field(description="false until WHATSAPP_APP_SECRET and WHATSAPP_VERIFY_TOKEN are set")


async def _store_whatsapp(db, svc, *, org: uuid.UUID, venture_id: uuid.UUID, user_id: uuid.UUID,
                          phone_number_id: str, token: str, info: dict[str, Any],
                          waba_id: str | None = None) -> WhatsAppConnectOut:
    display = info.get("display_phone_number")
    try:
        async with db.begin_nested():
            cid = (await db.execute(text(
                "INSERT INTO connectors (org_id, venture_id, provider, account_email, external_id, scopes, meta, created_by)"
                " VALUES (:o, :v, 'whatsapp', :d, :x, ARRAY['messages'], CAST(:m AS jsonb), :u)"
                " ON CONFLICT (venture_id, provider) DO UPDATE SET status = 'active', account_email = EXCLUDED.account_email,"
                " external_id = EXCLUDED.external_id, meta = connectors.meta || EXCLUDED.meta, last_error = NULL,"
                " updated_at = now() RETURNING id"),
                {"o": org, "v": venture_id, "d": display, "x": phone_number_id, "u": user_id,
                 "m": json.dumps({"waba_id": waba_id} if waba_id else {})})).scalar_one()
            enc = await EnvelopeCrypto(db, svc.keys).encrypt(venture_id, SECRET, token)
            await db.execute(text(
                "INSERT INTO connector_tokens (connector_id, org_id, venture_id, secret_enc) VALUES (:c, :o, :v, :s)"
                " ON CONFLICT (connector_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, updated_at = now()"),
                {"c": cid, "o": org, "v": venture_id, "s": enc})
    except DBAPIError as exc:
        if "connectors_provider_external_idx" in str(exc):
            raise HTTPException(status.HTTP_409_CONFLICT, "this phone number is connected to another business") from None
        raise_for_db(exc, "venture not found")
    return WhatsAppConnectOut(connector_id=cid, display_phone_number=display, verified_name=info.get("verified_name"),
                              webhook_url=f"{get_settings().public_api_url}/hooks/whatsapp",
                              webhook_ready=svc.whatsapp.configured)


@router.post("/ventures/{venture_id}/connectors/whatsapp", response_model=WhatsAppConnectOut, status_code=201)
async def connect_whatsapp(venture_id: uuid.UUID, body: WhatsAppConnectIn, user_id: UserId, db: TenantDB,
                           svc: Svc) -> WhatsAppConnectOut:
    """Connect the venture's WhatsApp Business number with a pasted id and token (the advanced way;
    most businesses use the signup below). The token is checked against Meta before it is stored
    (encrypted); it is never returned."""
    org = await _require_admin(db, venture_id)
    await require_integration(db, venture_id, "whatsapp")
    from kritvia_api.services.whatsapp import WhatsAppError
    try:
        info = await svc.whatsapp.check_number(body.phone_number_id, body.access_token)
    except WhatsAppError as exc:
        raise HTTPException(422, str(exc)) from None
    # The account id is only stored when the token proves the number belongs to it.
    if body.waba_id and body.phone_number_id not in await svc.whatsapp.number_ids(body.waba_id, body.access_token):
        raise HTTPException(422, "this phone number id isn't in that WhatsApp Business Account")
    return await _store_whatsapp(db, svc, org=org, venture_id=venture_id, user_id=user_id,
                                 phone_number_id=body.phone_number_id, token=body.access_token, info=info,
                                 waba_id=body.waba_id)


class WhatsAppSignupConfigOut(BaseModel):
    ready: bool = Field(description="false until the server has the Meta app id, signup configuration and app secret")
    app_id: str
    config_id: str
    graph_version: str


class WhatsAppSignupIn(BaseModel):
    code: str = Field(min_length=10, max_length=2000, description="from Meta's signup window (valid 30 seconds)")
    phone_number_id: str | None = Field(default=None, min_length=5, max_length=40, pattern=r"^\d+$",
                                        description="missing when Meta's window doesn't name it; looked up then")
    waba_id: str = Field(min_length=5, max_length=40, pattern=r"^\d+$")
    business_app: bool = Field(default=False, description="the number stays on the WhatsApp Business app (coexistence)")


@router.get("/ventures/{venture_id}/connectors/whatsapp/signup", response_model=WhatsAppSignupConfigOut)
async def whatsapp_signup_config(venture_id: uuid.UUID, db: TenantDB, svc: Svc) -> WhatsAppSignupConfigOut:
    """What the "Connect WhatsApp" button needs to open Meta's signup window."""
    from kritvia_api.services.whatsapp import GRAPH_VERSION
    await venture_org(db, venture_id)
    s = get_settings()
    ready = bool(s.meta_app_id and s.whatsapp_signup_config_id and svc.whatsapp.app_secret)
    return WhatsAppSignupConfigOut(ready=ready, app_id=s.meta_app_id if ready else "",
                                   config_id=s.whatsapp_signup_config_id if ready else "", graph_version=GRAPH_VERSION)


@router.post("/ventures/{venture_id}/connectors/whatsapp/signup", response_model=WhatsAppConnectOut, status_code=201)
async def whatsapp_signup(venture_id: uuid.UUID, body: WhatsAppSignupIn, user_id: UserId, db: TenantDB,
                          svc: Svc) -> WhatsAppConnectOut:
    """Finish "Connect WhatsApp": the owner logged in with Facebook and chose (or added) their number
    in Meta's window. Kritvia turns the code into access for this business, switches on incoming
    messages, activates the number and saves it, so nothing has to be copied by hand."""
    org = await _require_admin(db, venture_id)
    await require_integration(db, venture_id, "whatsapp")
    s = get_settings()
    if not (s.meta_app_id and s.whatsapp_signup_config_id and svc.whatsapp.app_secret):
        raise HTTPException(status.HTTP_409_CONFLICT, "WhatsApp sign-up isn't switched on for this server yet")
    from kritvia_api.services.whatsapp import WhatsAppError
    try:
        token = await svc.whatsapp.exchange_code(s.meta_app_id, body.code)
        pnid = body.phone_number_id or await svc.whatsapp.first_number(body.waba_id, token)
        # Proves the token reaches this number: the ids from the browser are never trusted alone.
        info = await svc.whatsapp.check_number(pnid, token)
        await svc.whatsapp.subscribe_app(body.waba_id, token)
        if not body.business_app:     # a number kept on the WhatsApp Business app is registered already
            await svc.whatsapp.register_number(pnid, token, f"{secrets.randbelow(10**6):06d}")
    except WhatsAppError as exc:
        raise HTTPException(422, str(exc)) from None
    return await _store_whatsapp(db, svc, org=org, venture_id=venture_id, user_id=user_id,
                                 phone_number_id=pnid, token=token, info=info, waba_id=body.waba_id)


@router.get("/hooks/whatsapp", response_model=None)
async def whatsapp_verify(request: Request, svc: Svc):
    """Meta's webhook verification handshake."""
    q = request.query_params
    if not svc.whatsapp.configured or q.get("hub.mode") != "subscribe" or \
            not hmac.compare_digest(q.get("hub.verify_token", ""), svc.whatsapp.verify_token):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "verification failed")
    from fastapi.responses import PlainTextResponse
    return PlainTextResponse(q.get("hub.challenge", ""))


class WhatsAppHookOut(BaseModel):
    accepted: int
    ignored: int = 0


async def _plan_allows(run_as: uuid.UUID, venture_id: uuid.UUID, integration: str) -> bool:
    """After a downgrade, inbound messages on an integration the plan lacks are ignored."""
    async with tenant_tx(run_as, "agent", "trigger") as conn:
        return (await plan_for_venture(conn, venture_id)).allows_integration(integration)


@router.post("/hooks/whatsapp", response_model=WhatsAppHookOut)
async def whatsapp_inbound(request: Request, svc: Svc) -> WhatsAppHookOut:
    """Inbound WhatsApp messages → one inbox_assistant run each (deduped by message id). Also takes
    messages the owner sent from the WhatsApp Business app (echoes) and Meta's template reviews.
    Always answers 200 once the signature checks out, so Meta does not retry."""
    from kritvia_api.routers.whatsapp_chats import notify_template, record_echo, record_template_status
    from kritvia_api.services.whatsapp import (parse_echoes, parse_inbound, parse_template_statuses,
                                               verify_signature)
    from kritvia_api.workflows.inbox import message_input
    await limiter.hit(f"hook-ip:{client_ip(request)}", per_minute=600)
    body = await request.body()
    if len(body) > 256 * 1024:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "payload too large")
    if not verify_signature(svc.whatsapp.app_secret, body, request.headers.get("X-Hub-Signature-256")):
        await security_event("webhook.bad_signature", "warning", request=request, provider="whatsapp")
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad signature")
    try:
        payload = json.loads(body)
    except ValueError:
        raise HTTPException(422, "body must be JSON") from None
    accepted = ignored = 0
    principals: dict[str, Any] = {}
    for m in parse_inbound(payload if isinstance(payload, dict) else {}):
        if m.phone_number_id not in principals:
            async with tenant_tx(None, "system") as conn:
                principals[m.phone_number_id] = (await conn.execute(
                    text("SELECT * FROM private.whatsapp_principal(:p)"), {"p": m.phone_number_id})).first()
        p = principals[m.phone_number_id]
        if p is None or not await _plan_allows(p.run_as, p.venture_id, "whatsapp"):
            ignored += 1
            continue
        # Every message is kept in the customer's chat first (WhatsApp page, and the history agents read).
        async with tenant_tx(p.run_as, "agent", "whatsapp") as conn:
            contact, new = await wa_inbox.record_inbound(
                conn, EnvelopeCrypto(conn, svc.keys), org_id=p.org_id, venture_id=p.venture_id, phone=m.sender,
                name=m.sender_name, body=m.text, kind=m.kind, provider_id=m.message_id)
        if not new:                      # Meta redelivered a message we already have
            ignored += 1
            continue
        if not contact.automatic:
            # A person is handling this chat, or the customer opted out: keep the message, draft nothing.
            accepted += 1
            if contact.handled_by == "person" and not contact.opted_out:
                await push.notify_venture(p.venture_id, title="New WhatsApp message",
                                          body=f"{contact.name or '+' + contact.phone} wrote again",
                                          url=f"/v/{p.venture_id}/whatsapp?c={contact.id}", tag=f"wa-{contact.id}")
            continue
        try:
            await start_run(svc, actor_user_id=p.run_as, actor_type="agent", venture_id=p.venture_id,
                            workflow="inbox_assistant", trigger_kind="whatsapp", trigger_ref=m.message_id,
                            dedupe=("whatsapp", m.message_id),
                            title=f"WhatsApp: {(m.sender_name or m.sender)[:60]} — {m.text[:60]}",
                            input=message_input(channel="whatsapp", from_name=m.sender_name, from_phone=m.sender,
                                                subject=None, body=m.text, message_id=m.message_id))
            accepted += 1
        except DuplicateTrigger:
            ignored += 1
        except ValueError:   # workflow disabled or venture kind mismatch: ignore, don't make Meta retry
            ignored += 1
    for e in parse_echoes(payload if isinstance(payload, dict) else {}):
        if e.phone_number_id not in principals:
            async with tenant_tx(None, "system") as conn:
                principals[e.phone_number_id] = (await conn.execute(
                    text("SELECT * FROM private.whatsapp_principal(:p)"), {"p": e.phone_number_id})).first()
        p = principals[e.phone_number_id]
        if p is None:
            ignored += 1
            continue
        async with tenant_tx(p.run_as, "agent", "whatsapp") as conn:
            waiting = await record_echo(conn, EnvelopeCrypto(conn, svc.keys), org_id=p.org_id,
                                        venture_id=p.venture_id, to=e.to, body=e.text, kind=e.kind,
                                        provider_id=e.message_id)
        if waiting is None:
            ignored += 1
            continue
        await wa_inbox.withdraw_drafts(p.run_as, waiting)
        accepted += 1
    for t in parse_template_statuses(payload if isinstance(payload, dict) else {}):
        async with tenant_tx(None, "system") as conn:
            owners = (await conn.execute(text("SELECT * FROM private.whatsapp_waba_principals(:w)"),
                                         {"w": t.waba_id})).all()
        if not owners:
            ignored += 1
        for p in owners:
            async with tenant_tx(p.run_as, "agent", "whatsapp") as conn:
                changed = await record_template_status(conn, p.venture_id, meta_id=t.meta_id, name=t.name,
                                                       language=t.language, status_=t.status, reason=t.reason)
            if changed:
                await notify_template(p.venture_id, changed, t.status, t.reason)
            accepted += 1
    return WhatsAppHookOut(accepted=accepted, ignored=ignored)

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
            await security_event("webhook.stale", "warning", request=request, org_id=p.org_id, provider="lead_form")
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "stale or invalid timestamp")
        if not hmac.compare_digest(sig, sign(secret, ts, body)):
            await security_event("webhook.bad_signature", "warning", request=request, org_id=p.org_id, provider="lead_form")
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad signature")
        # Replays inside the 5-minute window are harmless: the same body maps to the same run
        # (deduplicated below), so a re-sent request never starts a second one.
    elif not (key and hmac.compare_digest(key, secret)):
        await security_event("webhook.bad_signature", "warning", request=request, org_id=p.org_id, provider="lead_form")
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
    # Lead triage when the business runs it; otherwise the inbox assistant answers the form.
    async with tenant_tx(p.run_as, "agent", "webhook") as conn:
        on = {r.workflow for r in (await conn.execute(text(
            "SELECT workflow FROM workflow_configs WHERE venture_id = :v AND enabled"
            " AND workflow IN ('lead_triage', 'inbox_assistant')"), {"v": p.venture_id})).all()}
    if "lead_triage" in on or "inbox_assistant" not in on:
        workflow, inp = "lead_triage", lead
    else:
        from kritvia_api.workflows.inbox import message_input
        workflow = "inbox_assistant"
        inp = message_input(channel="email", from_name=lead.get("from_name"), from_email=lead.get("from_email"),
                            subject=lead.get("subject"), body=lead["body"], message_id=None)
    try:
        run_id = await start_run(svc, actor_user_id=p.run_as, actor_type="agent", venture_id=p.venture_id,
                                 workflow=workflow, input=inp, trigger_kind="webhook",
                                 dedupe=("webhook", hashlib.sha256(body).hexdigest()),
                                 title=f"Web form: {lead.get('company') or lead.get('from_name') or 'lead'}")
    except DuplicateTrigger:
        return HookOut(accepted=True, duplicate=True)
    except ValueError as exc:
        raise HTTPException(402 if isinstance(exc, PlanRestricted) else 422, str(exc)) from None
    return HookOut(accepted=True, run_id=run_id)

