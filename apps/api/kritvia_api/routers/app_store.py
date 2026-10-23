"""The App store: install any MCP server, a GitHub project, or any web app with an API, so the assistant can
use it (migration 0067).

Installed apps (a business's admins manage them; everyone in the business sees them):
  GET    /ventures/{v}/apps                       installed apps and their tools
  POST   /ventures/{v}/apps                       by address: an MCP server (no auth, a token, the app's own
                                                  header, or basic) or a web app's OpenAPI description
  POST   /ventures/{v}/apps/hosted                an app from npm/PyPI/a container image that Kritvia's team
                                                  approved, run in the sandboxed MCP runner
  POST   /ventures/{v}/apps/oauth/start           sign in to an MCP app (OAuth, PKCE) -> the address to go to
  POST   /apps/oauth/complete                     the sign-in came back (web callback /api/oauth/mcp/callback)
  POST   /ventures/{v}/apps/{id}/refresh          read its tools again
  DELETE /ventures/{v}/apps/{id}                  remove it
  POST   /ventures/{v}/apps/{id}/hook             a secret address the app can send events to (shown once)
  DELETE /ventures/{v}/apps/{id}/hook
  POST   /hooks/apps/{id}                         an app's event -> the business's event stream ("app.event")
  GET    /public/mcp-client.json                  Kritvia's OAuth client ID metadata document
The store:
  GET    /app-store                               search Kritvia's verified apps, the MCP Registry, approved
                                                  GitHub projects
  POST   /app-store/request                       ask Kritvia's team to review a package app from the registry
  POST   /ventures/{v}/apps/github                what a GitHub project is (skills, a hosted address, a package)
  POST   /ventures/{v}/apps/github/skills         import its SKILL.md files as Kritvia skills
  POST   /ventures/{v}/apps/github/submit         send a package app to Kritvia's team for review
Kritvia's team:
  GET    /staff/apps                              everything sent in, waiting first
  POST   /staff/apps/review                       approve (with the internet sites it may reach) or reject
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
import secrets
import uuid
from datetime import datetime
from types import SimpleNamespace
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.config import get_settings
from kritvia_api.db.session import tenant_tx
from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.errors import raise_for_db
from kritvia_api.ratelimit import client_ip, limiter
from kritvia_api.routers.partners import _staff
from kritvia_api.services import app_catalog, github_install, mcp, mcp_oauth, openapi_app
from kritvia_api.services.crypto import EnvelopeCrypto
from kritvia_api.services.quota import require_integration
from kritvia_api.services.security_log import security_event

log = logging.getLogger(__name__)
router = APIRouter(tags=["app-store"])
NAME = r"^[a-z][a-z0-9_]{1,23}$"
HOST_RE = re.compile(r"^(\*\.)?([a-z0-9-]{1,63}\.)+[a-z]{2,63}$")
OAUTH_MINUTES = 15


# ------------------------------------------------------------------------------------ models --
class AppTool(BaseModel):
    name: str
    description: str
    read_only: bool = Field(description="runs without an approval (only for apps Kritvia has checked)")


class AppOut(BaseModel):
    id: uuid.UUID
    name: str
    kind: Literal["mcp", "hosted", "openapi"]
    url: str
    auth: Literal["none", "bearer", "header", "basic", "oauth"]
    status: str
    has_token: bool
    has_hook: bool
    catalog_id: str | None
    tools: list[AppTool]
    last_error: str | None
    updated_at: datetime


class AppIn(BaseModel):
    name: str = Field(pattern=NAME, description="short name, e.g. hubspot")
    url: str = Field(min_length=10, max_length=500, description="the MCP address, or the OpenAPI description's address")
    kind: Literal["mcp", "openapi"] = "mcp"
    auth: Literal["none", "bearer", "header", "basic"] | None = Field(
        default=None, description="how the token is sent (default: bearer when a token is given)")
    header_name: str | None = Field(default=None, pattern=r"^[A-Za-z0-9-]{1,60}$")
    token: str | None = Field(default=None, max_length=4000, description="for basic: user:password")
    base_url: str | None = Field(default=None, max_length=500, description="openapi: the API's address, if the "
                                                                          "description doesn't say")
    catalog_id: str | None = Field(default=None, max_length=200)


class HostedIn(BaseModel):
    name: str = Field(pattern=NAME)
    catalog_id: str = Field(max_length=200)
    env: dict[str, str] = Field(default_factory=dict, description="the app's settings (API keys…), stored encrypted")


class OAuthStartIn(BaseModel):
    name: str = Field(pattern=NAME)
    url: str = Field(min_length=10, max_length=500)
    catalog_id: str | None = Field(default=None, max_length=200)
    nonce: str = Field(min_length=32, max_length=128, description="set by the web app; binds the sign-in to this browser")


class OAuthStartOut(BaseModel):
    authorize_url: str


class OAuthCompleteIn(BaseModel):
    state: str = Field(min_length=32, max_length=100)
    code: str = Field(min_length=1, max_length=2000)
    iss: str | None = Field(default=None, max_length=500)
    nonce: str = Field(min_length=32, max_length=128)


class OAuthCompleteOut(BaseModel):
    venture_id: uuid.UUID
    app: AppOut


class AppHookOut(BaseModel):
    url: str
    secret: str = Field(description="shown once: the app sends it as 'Authorization: Bearer <secret>'")


class AppHookIn(BaseModel):
    accepted: bool


class CatalogEnv(BaseModel):
    name: str
    secret: bool = False
    required: bool = False
    description: str = ""


class CatalogApp(BaseModel):
    id: str
    source: Literal["kritvia", "registry", "github"]
    kind: Literal["mcp", "hosted", "skills"]
    title: str
    description: str | None
    url: str | None
    auth_modes: list[str]
    header_name: str | None
    docs_url: str | None
    repo_url: str | None
    package: str | None = Field(default=None, description="hosted: registry type, name and version")
    env: list[CatalogEnv] = Field(default_factory=list)
    egress_hosts: list[str]
    status: Literal["listed", "pending", "approved", "rejected"]
    installable: bool


class AppReviewAsk(BaseModel):
    id: str = Field(max_length=200)


class AppReviewAskOut(BaseModel):
    status: str


class GithubIn(BaseModel):
    url: str = Field(min_length=19, max_length=500)


class GithubSkill(BaseModel):
    path: str
    name: str
    description: str
    instructions: str


class GithubOut(BaseModel):
    repo: str
    repo_url: str
    title: str
    description: str
    stars: int
    archived: bool
    license: str | None
    kind: Literal["skills", "remote", "hosted", "none"]
    skills: list[GithubSkill]
    remote: str | None
    package: str | None
    unpublished: str | None = Field(default=None, description="an MCP server that isn't published (npm/PyPI)")
    catalog: CatalogApp | None = Field(default=None, description="hosted: its entry in the store, if sent in")


class GithubSkillsIn(BaseModel):
    url: str = Field(min_length=19, max_length=500)
    paths: list[str] = Field(min_length=1, max_length=20)


class GithubSkillsOut(BaseModel):
    skill_ids: list[uuid.UUID]


class GithubSubmitIn(BaseModel):
    url: str = Field(min_length=19, max_length=500)
    note: str | None = Field(default=None, max_length=500)


class StaffApp(CatalogApp):
    review_note: str | None
    submitted_by: str | None
    reviewed_at: datetime | None
    updated_at: datetime


class ReviewIn(BaseModel):
    id: str = Field(max_length=200)
    status: Literal["approved", "rejected", "pending"]
    egress_hosts: list[str] = Field(default_factory=list, max_length=30,
                                    description="the internet sites it may reach, e.g. api.example.com")
    note: str | None = Field(default=None, max_length=500)


# ----------------------------------------------------------------------------------- helpers --
APP_COLS = ("id, name, kind, url, auth, status, token_enc IS NOT NULL AS has_token, hook_secret_hash IS NOT NULL"
            " AS has_hook, catalog_id, tools, last_error, updated_at")


def _app(r) -> AppOut:
    return AppOut(id=r.id, name=r.name, kind=r.kind, url=r.url, auth=r.auth, status=r.status, has_token=r.has_token,
                  has_hook=r.has_hook, catalog_id=r.catalog_id, last_error=r.last_error, updated_at=r.updated_at,
                  tools=[AppTool(name=t.get("name", ""), description=t.get("description", ""),
                                 read_only=bool(t.get("read_only")) and mcp.trusts_read_only(r.kind, r.url))
                         for t in (r.tools or [])])


async def _require_admin(db, venture_id: uuid.UUID) -> uuid.UUID:
    org = await venture_org(db, venture_id)        # 404 for a business the caller can't see, before 403
    ok = (await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar()
    if not ok:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only the business's admins can manage connected apps")
    return org


async def _insert(db, *, org: uuid.UUID, venture_id: uuid.UUID, user_id: uuid.UUID, name: str, values: dict[str, Any],
                  tools: list[mcp.AppTool], app_id: uuid.UUID | None = None) -> AppOut:
    cols = {"id": app_id or uuid.uuid4(), "org_id": org, "venture_id": venture_id, "name": name,
            "tools": json.dumps([mcp.tool_to_json(t) for t in tools]), "created_by": user_id, **values}
    casts = {"tools": "CAST(:tools AS jsonb)", "spec": "CAST(:spec AS jsonb)"}
    try:
        async with db.begin_nested():
            r = (await db.execute(text(
                f"INSERT INTO mcp_servers ({', '.join(cols)}) VALUES ({', '.join(casts.get(k, ':' + k) for k in cols)})"
                f" RETURNING {APP_COLS}"), cols)).first()
    except DBAPIError as exc:
        if "mcp_servers_venture_id_name_key" in str(exc):
            raise HTTPException(status.HTTP_409_CONFLICT, f"an app called {name!r} is already connected") from None
        raise_for_db(exc, "venture not found")
    return _app(r)


def _catalog(r) -> CatalogApp:
    pk = r.package or {}
    pkg = f"{pk.get('registryType')} {pk.get('identifier')}@{pk.get('version')}" if pk.get("identifier") else None
    installable = (r.kind != "hosted" and r.status in ("listed", "approved")) or (
        r.kind == "hosted" and (r.status == "approved" or (r.source == "kritvia" and r.status == "listed")))
    return CatalogApp(id=r.id, source=r.source, kind=r.kind, title=r.title, description=r.description, url=r.url,
                      auth_modes=list(r.auth_modes or []), header_name=r.header_name, docs_url=r.docs_url,
                      repo_url=r.repo_url, package=pkg, env=[CatalogEnv(**e) for e in pk.get("env") or []],
                      egress_hosts=list(r.egress_hosts or []), status=r.status, installable=installable)


def _nonce_hash(nonce: str) -> str:
    return hashlib.sha256(nonce.encode()).hexdigest()


# ------------------------------------------------------------------------------ installed apps --
@router.get("/ventures/{venture_id}/apps", response_model=list[AppOut])
async def list_apps(venture_id: uuid.UUID, db: TenantDB) -> list[AppOut]:
    rows = (await db.execute(text(f"SELECT {APP_COLS} FROM mcp_servers WHERE venture_id = :v ORDER BY name"),
                             {"v": venture_id})).all()
    return [_app(r) for r in rows]


@router.post("/ventures/{venture_id}/apps", response_model=AppOut, status_code=201)
async def add_app(venture_id: uuid.UUID, body: AppIn, user_id: UserId, svc: Svc, db: TenantDB) -> AppOut:
    org = await _require_admin(db, venture_id)
    await require_integration(db, venture_id, "mcp")
    token = (body.token or "").strip() or None
    auth = body.auth or ("bearer" if token else "none")
    if auth == "header" and not body.header_name:
        raise HTTPException(422, "say which header the token goes in")
    if auth != "none" and not token:
        raise HTTPException(422, "this way of connecting needs a token")
    if auth == "basic" and token and ":" not in token:
        raise HTTPException(422, "for basic sign-in, give user:password (or key:secret)")
    headers = mcp.auth_headers(auth, token, body.header_name)
    spec = None
    try:
        url = await mcp.check_url(body.url)
        if body.kind == "openapi":
            base = await mcp.check_url(body.base_url) if body.base_url else None
            spec = openapi_app.parse(await openapi_app.fetch(url), url, base)
            await mcp.check_url(spec["base_url"])
            tools = openapi_app.tools(spec, body.name)
        else:
            tools = await mcp.Client(url, headers=headers).list_tools(body.name)
    except mcp.McpError as exc:
        raise HTTPException(422, f"couldn't connect: {exc}") from None
    if not tools:
        raise HTTPException(422, "the app answered but offers no tools")
    enc = await EnvelopeCrypto(db, svc.keys).encrypt(venture_id, mcp.TOKEN_PURPOSE, token) if token else None
    return await _insert(db, org=org, venture_id=venture_id, user_id=user_id, name=body.name, tools=tools, values={
        "url": url, "kind": body.kind, "auth": auth, "header_name": body.header_name if auth == "header" else None,
        "token_enc": enc, "spec": json.dumps(spec) if spec else None, "catalog_id": body.catalog_id})


@router.post("/ventures/{venture_id}/apps/hosted", response_model=AppOut, status_code=201)
async def add_hosted(venture_id: uuid.UUID, body: HostedIn, user_id: UserId, svc: Svc, db: TenantDB) -> AppOut:
    org = await _require_admin(db, venture_id)
    await require_integration(db, venture_id, "mcp")
    env = {k: v.strip() for k, v in body.env.items() if v and v.strip()}
    try:
        cfg = await mcp.hosted_config(db, body.catalog_id, env)
    except mcp.McpError as exc:
        raise HTTPException(422, str(exc)) from None
    known = {e["name"]: e for e in cfg["package"].get("env") or []}
    if set(env) - set(known):
        raise HTTPException(422, f"unknown settings: {', '.join(sorted(set(env) - set(known)))}")
    missing = [n for n, e in known.items() if e.get("required") and n not in env]
    if missing:
        raise HTTPException(422, f"this app needs: {', '.join(missing)}")
    if any(len(v) > 2000 for v in env.values()):
        raise HTTPException(422, "a setting is too long")
    app_id = uuid.uuid4()
    url = f"runner:{app_id}"
    try:
        await mcp.configure_runner(str(app_id), cfg)
        tools = await mcp.Client(url).list_tools(body.name)
    except mcp.McpError as exc:
        await mcp.stop_runner(str(app_id))
        raise HTTPException(422, f"couldn't start the app: {exc}") from None
    if not tools:
        await mcp.stop_runner(str(app_id))
        raise HTTPException(422, "the app started but offers no tools")
    enc = await EnvelopeCrypto(db, svc.keys).encrypt(venture_id, mcp.TOKEN_PURPOSE, json.dumps(env)) if env else None
    try:
        return await _insert(db, org=org, venture_id=venture_id, user_id=user_id, name=body.name, tools=tools,
                             app_id=app_id, values={"url": url, "kind": "hosted", "auth": "none", "token_enc": enc,
                                                    "catalog_id": body.catalog_id})
    except HTTPException:
        await mcp.stop_runner(str(app_id))
        raise


@router.post("/ventures/{venture_id}/apps/oauth/start", response_model=OAuthStartOut)
async def oauth_start(venture_id: uuid.UUID, body: OAuthStartIn, user_id: UserId, svc: Svc,
                      db: TenantDB) -> OAuthStartOut:
    org = await _require_admin(db, venture_id)
    await require_integration(db, venture_id, "mcp")
    await limiter.hit(f"mcp-oauth:{user_id}", per_minute=20)
    existing = (await db.execute(text("SELECT url, auth FROM mcp_servers WHERE venture_id = :v AND name = :n"),
                                 {"v": venture_id, "n": body.name})).first()
    if existing is not None and (existing.url != body.url.strip() or existing.auth != "oauth"):
        raise HTTPException(status.HTTP_409_CONFLICT, f"an app called {body.name!r} is already connected")
    try:
        d = await mcp_oauth.discover(body.url)
        client = await mcp_oauth.register(d)
    except mcp.McpError as exc:
        raise HTTPException(422, f"couldn't start the sign-in: {exc}") from None
    authorize_url, saved = mcp_oauth.start(d, client)
    saved.update({"name": body.name, "url": await mcp.check_url(body.url), "catalog_id": body.catalog_id,
                  "nonce": _nonce_hash(body.nonce)})
    enc = await EnvelopeCrypto(db, svc.keys).encrypt(venture_id, mcp_oauth.PURPOSE, json.dumps(saved))
    await db.execute(text("DELETE FROM app_oauth_pending WHERE user_id = :u AND created_at < now() - interval '1 hour'"),
                     {"u": user_id})
    await db.execute(text("INSERT INTO app_oauth_pending (state, org_id, venture_id, user_id, data_enc)"
                          " VALUES (:s, :o, :v, :u, :d)"),
                     {"s": saved["state"], "o": org, "v": venture_id, "u": user_id, "d": enc})
    return OAuthStartOut(authorize_url=authorize_url)


@router.post("/apps/oauth/complete", response_model=OAuthCompleteOut)
async def oauth_complete(body: OAuthCompleteIn, user_id: UserId, svc: Svc, db: TenantDB) -> OAuthCompleteOut:
    p = (await db.execute(text(
        "DELETE FROM app_oauth_pending WHERE state = :s AND user_id = :u RETURNING org_id, venture_id, data_enc,"
        f" created_at > now() - interval '{OAUTH_MINUTES} minutes' AS fresh"), {"s": body.state, "u": user_id})).first()
    if p is None or not p.fresh:
        raise HTTPException(400, "this sign-in link has expired or was started by someone else; start again")
    crypto = EnvelopeCrypto(db, svc.keys)
    saved = json.loads((await crypto.decrypt(p.venture_id, mcp_oauth.PURPOSE, p.data_enc)).decode())
    if not hmac.compare_digest(saved.get("nonce", ""), _nonce_hash(body.nonce)):
        raise HTTPException(400, "this sign-in was started in another browser; start again")
    await _require_admin(db, p.venture_id)
    try:
        tok = await mcp_oauth.exchange(saved, body.code, body.iss)
        tools = await mcp.Client(saved["url"], headers={"Authorization": f"Bearer {tok['access_token']}"}) \
            .list_tools(saved["name"])
    except mcp.McpError as exc:
        raise HTTPException(422, f"couldn't connect: {exc}") from None
    if not tools:
        raise HTTPException(422, "the app answered but offers no tools")
    enc = await crypto.encrypt(p.venture_id, mcp_oauth.PURPOSE, json.dumps(tok))
    r = (await db.execute(text(
        "UPDATE mcp_servers SET oauth_enc = :e, status = 'active', last_error = NULL, tools = CAST(:t AS jsonb),"
        f" updated_at = now() WHERE venture_id = :v AND name = :n AND auth = 'oauth' RETURNING {APP_COLS}"),
        {"e": enc, "t": json.dumps([mcp.tool_to_json(t) for t in tools]), "v": p.venture_id,
         "n": saved["name"]})).first()
    if r is not None:
        return OAuthCompleteOut(venture_id=p.venture_id, app=_app(r))
    app = await _insert(db, org=p.org_id, venture_id=p.venture_id, user_id=user_id, name=saved["name"], tools=tools,
                        values={"url": saved["url"], "kind": "mcp", "auth": "oauth", "oauth_enc": enc,
                                "catalog_id": saved.get("catalog_id")})
    return OAuthCompleteOut(venture_id=p.venture_id, app=app)


@router.get("/public/mcp-client.json")
async def mcp_client_document() -> dict[str, Any]:
    """Kritvia's OAuth Client ID Metadata Document (its address is the client_id)."""
    return mcp_oauth.client_document()


@router.post("/ventures/{venture_id}/apps/{app_id}/refresh", response_model=AppOut)
async def refresh_app(venture_id: uuid.UUID, app_id: uuid.UUID, svc: Svc, db: TenantDB) -> AppOut:
    await _require_admin(db, venture_id)
    row = (await db.execute(text(f"SELECT {mcp.ROW_COLS} FROM mcp_servers WHERE id = :id AND venture_id = :v"),
                            {"id": app_id, "v": venture_id})).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "app not found")
    try:
        link = await mcp.load_link(db, EnvelopeCrypto(db, svc.keys), venture_id, row)
        if row.kind == "openapi":
            link.spec = openapi_app.parse(await openapi_app.fetch(row.spec["spec_url"]), row.spec["spec_url"],
                                          row.spec["base_url"])
        tools = await mcp.link_tools(link, row.name)
        sets = "tools = CAST(:tools AS jsonb), status = 'active', last_error = NULL"
        params: dict[str, Any] = {"tools": json.dumps([mcp.tool_to_json(t) for t in tools])}
        if row.kind == "openapi":
            sets += ", spec = CAST(:spec AS jsonb)"
            params["spec"] = json.dumps(link.spec)
    except mcp.McpError as exc:
        sets = "status = CASE WHEN status = 'needs_auth' THEN status ELSE 'error' END, last_error = :e"
        params = {"e": str(exc)[:300]}
    r = (await db.execute(text(f"UPDATE mcp_servers SET {sets}, updated_at = now() WHERE id = :id"
                               f" RETURNING {APP_COLS}"), {"id": app_id, **params})).first()
    return _app(r)


@router.delete("/ventures/{venture_id}/apps/{app_id}", status_code=204)
async def remove_app(venture_id: uuid.UUID, app_id: uuid.UUID, db: TenantDB) -> None:
    await _require_admin(db, venture_id)
    kind = (await db.execute(text("DELETE FROM mcp_servers WHERE id = :id AND venture_id = :v RETURNING kind"),
                             {"id": app_id, "v": venture_id})).scalar()
    if kind is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "app not found")
    if kind == "hosted":
        await mcp.stop_runner(str(app_id))


@router.post("/ventures/{venture_id}/apps/{app_id}/hook", response_model=AppHookOut)
async def make_hook(venture_id: uuid.UUID, app_id: uuid.UUID, db: TenantDB) -> AppHookOut:
    await _require_admin(db, venture_id)
    secret = "kvh_" + secrets.token_urlsafe(32)
    done = (await db.execute(text("UPDATE mcp_servers SET hook_secret_hash = :h, updated_at = now()"
                                  " WHERE id = :id AND venture_id = :v RETURNING id"),
                             {"h": hashlib.sha256(secret.encode()).hexdigest(), "id": app_id, "v": venture_id})).first()
    if done is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "app not found")
    return AppHookOut(url=f"{get_settings().public_api_url.rstrip('/')}/hooks/apps/{app_id}", secret=secret)


@router.delete("/ventures/{venture_id}/apps/{app_id}/hook", status_code=204)
async def remove_hook(venture_id: uuid.UUID, app_id: uuid.UUID, db: TenantDB) -> None:
    await _require_admin(db, venture_id)
    await db.execute(text("UPDATE mcp_servers SET hook_secret_hash = NULL, updated_at = now()"
                          " WHERE id = :id AND venture_id = :v"), {"id": app_id, "v": venture_id})


def _summary(payload: Any) -> str:
    if isinstance(payload, dict):
        for k in ("summary", "text", "message", "title", "event", "type"):
            if isinstance(payload.get(k), str) and payload[k].strip():
                return payload[k].strip()[:280]
    return json.dumps(payload, ensure_ascii=False, default=str)[:280]


@router.post("/hooks/apps/{app_id}", response_model=AppHookIn, status_code=202)
async def app_hook(app_id: uuid.UUID, request: Request) -> AppHookIn:
    """An installed app tells the business something happened. The app sends its secret as a bearer token;
    only a short summary is kept, as an 'app.event' on the business's event stream."""
    await limiter.hit(f"hook-ip:{client_ip(request)}", per_minute=600)
    secret = (request.headers.get("authorization") or "").removeprefix("Bearer ").strip()
    p = None
    if secret:
        async with tenant_tx(None, "system") as conn:
            p = (await conn.execute(text("SELECT * FROM private.app_hook_principal(:id)"), {"id": app_id})).first()
    if p is None or not hmac.compare_digest(p.hook_secret_hash or "", hashlib.sha256(secret.encode()).hexdigest()):
        await security_event("webhook.bad_signature", "warning", request=request, provider="app")
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad secret")
    raw = await request.body()
    if len(raw) > 64 * 1024:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "payload too large")
    try:
        payload = json.loads(raw) if raw else {}
    except ValueError:
        payload = raw.decode("utf-8", "replace")
    async with tenant_tx(None, "system") as conn:
        ok = (await conn.execute(text("SELECT private.app_event(:id, :s)"),
                                 {"id": app_id, "s": _summary(payload)})).scalar()
    if not ok:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "too many events from this app this hour")
    return AppHookIn(accepted=True)


# ----------------------------------------------------------------------------------- the store --
@router.get("/app-store", response_model=list[CatalogApp])
async def store(user_id: UserId, db: TenantDB, q: str | None = None,
                source: Literal["kritvia", "registry", "github"] | None = None, limit: int = 30) -> list[CatalogApp]:
    have = (await db.execute(text("SELECT count(*) FROM app_catalog WHERE source = 'kritvia'"))).scalar()
    if have < len(app_catalog.KRITVIA_APPS):
        await app_catalog.seed(db)
    return [_catalog(r) for r in await app_catalog.search(db, q, source, limit)]


@router.post("/app-store/request", response_model=AppReviewAskOut)
async def request_review(body: AppReviewAsk, user_id: UserId, db: TenantDB) -> AppReviewAskOut:
    st = (await db.execute(text("SELECT private.catalog_request(:id, :u)"), {"id": body.id, "u": user_id})).scalar()
    if st is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "that app isn't one Kritvia's team reviews")
    if st == "pending":
        await _tell_team(f"App to review: {body.id}", f"A business asked for {body.id} in the App store.")
    return AppReviewAskOut(status=st)


async def _tell_team(subject: str, body: str) -> None:
    from kritvia_api.services.mailer import get_mailer
    from kritvia_api.services.watchdog import _team
    for to in _team():
        try:
            await get_mailer().send(to, f"Kritvia: {subject}"[:200], body + "\n\nReview it at /staff/apps.")
        except Exception:  # noqa: BLE001 - the staff page still shows it
            log.exception("app review email failed")


async def _analyse(url: str) -> dict[str, Any]:
    try:
        return await github_install.analyse(url)
    except mcp.McpError as exc:
        raise HTTPException(422, str(exc)) from None


def _pkg_text(p: dict[str, Any] | None) -> str | None:
    return f"{p['registryType']} {p['identifier']}@{p['version']}" if p else None


@router.post("/ventures/{venture_id}/apps/github", response_model=GithubOut)
async def github_analyse(venture_id: uuid.UUID, body: GithubIn, user_id: UserId, db: TenantDB) -> GithubOut:
    await _require_admin(db, venture_id)
    await limiter.hit(f"github:{user_id}", per_minute=10)
    a = await _analyse(body.url)
    entry = None
    if a["kind"] == "hosted":
        r = (await db.execute(text(f"SELECT {app_catalog.SEARCH_COLS} FROM app_catalog WHERE id = :id"),
                              {"id": github_install.catalog_id(a["repo"])})).first()
        entry = _catalog(r) if r else None
    return GithubOut(repo=a["repo"], repo_url=a["repo_url"], title=a["title"], description=a["description"],
                     stars=a["stars"], archived=a["archived"], license=a["license"], kind=a["kind"],
                     skills=[GithubSkill(**s) for s in a["skills"]], remote=a["remote"],
                     package=_pkg_text(a["package"]), unpublished=a.get("unpublished"), catalog=entry)


@router.post("/ventures/{venture_id}/apps/github/skills", response_model=GithubSkillsOut, status_code=201)
async def github_skills(venture_id: uuid.UUID, body: GithubSkillsIn, user_id: UserId, svc: Svc,
                        db: TenantDB) -> GithubSkillsOut:
    from kritvia_api.services import skills as sk
    org = await _require_admin(db, venture_id)
    a = await _analyse(body.url)
    found = {s["path"]: s for s in a["skills"]}
    chosen = [found[p] for p in body.paths if p in found]
    if not chosen:
        raise HTTPException(422, "none of those skills are in the project")
    crypto = EnvelopeCrypto(db, svc.keys)
    ids = []
    for s in chosen:
        d = sk.clean(sk.Draft(name=s["name"][:80], instructions=s["instructions"][:2000], trigger="manual"))
        ids.append(await sk.create(db, crypto, org_id=org, venture_id=venture_id, created_by=user_id, d=d))
    return GithubSkillsOut(skill_ids=ids)


@router.post("/ventures/{venture_id}/apps/github/submit", response_model=CatalogApp, status_code=201)
async def github_submit(venture_id: uuid.UUID, body: GithubSubmitIn, user_id: UserId, db: TenantDB) -> CatalogApp:
    await _require_admin(db, venture_id)
    a = await _analyse(body.url)
    if a["kind"] != "hosted" or not a["package"]:
        raise HTTPException(422, "only MCP servers published to npm or PyPI can be sent for review")
    if a["archived"]:
        raise HTTPException(422, "that project is archived")
    cid = github_install.catalog_id(a["repo"])
    await db.execute(text("SELECT private.catalog_upsert(CAST(:p AS jsonb))"), {"p": json.dumps({
        "id": cid, "source": "github", "kind": "hosted", "title": a["title"],
        "description": (a["description"] + (f"\n\nNote from the business: {body.note}" if body.note else ""))[:1000],
        "repo_url": a["repo_url"], "docs_url": a["repo_url"], "package": a["package"], "status": "pending",
        "submitted_by": str(user_id)})})
    r = (await db.execute(text(f"SELECT {app_catalog.SEARCH_COLS} FROM app_catalog WHERE id = :id"), {"id": cid})).first()
    if r is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "that project is already in the store")
    if r.status == "pending":
        await _tell_team(f"App to review: {a['repo']}", f"{a['repo_url']} ({_pkg_text(a['package'])}) was sent in.")
    return _catalog(r)


# ------------------------------------------------------------------------------ Kritvia's team --
@router.get("/staff/apps", response_model=list[StaffApp])
async def staff_apps(user_id: UserId, db: TenantDB) -> list[StaffApp]:
    await _staff(db, user_id)
    rows = (await db.execute(text("SELECT * FROM private.catalog_all()"))).scalars().all()
    out = []
    for d in rows:
        r = SimpleNamespace(**d)
        out.append(StaffApp(**_catalog(r).model_dump(), review_note=r.review_note, submitted_by=r.submitter,
                            reviewed_at=r.reviewed_at, updated_at=r.updated_at))
    return out


@router.post("/staff/apps/review", response_model=list[StaffApp])
async def staff_review(body: ReviewIn, user_id: UserId, db: TenantDB) -> list[StaffApp]:
    await _staff(db, user_id)
    hosts = sorted({h.strip().lower() for h in body.egress_hosts if h.strip()})
    bad = [h for h in hosts if not HOST_RE.match(h)]
    if bad:
        raise HTTPException(422, f"not a site name: {', '.join(bad)}")
    ok = (await db.execute(text("SELECT private.catalog_review(:id, :s, :h, :n, :u)"),
                           {"id": body.id, "s": body.status, "h": hosts, "n": body.note, "u": user_id})).scalar()
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "nothing to review with that id")
    return await staff_apps(user_id, db)
