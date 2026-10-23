from contextlib import asynccontextmanager

import logging

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DBAPIError

from kritvia_api.bodylimit import BodyLimitMiddleware
from kritvia_api.config import get_settings
from kritvia_api.db.session import dispose_engine
from kritvia_api.errors import sqlstate
from kritvia_api.routers import (agent_team, ads, app_store, ai_models, bank, cash, bills, browser, campaigns, events, people, social, calls, analytics, api_keys, custom_workflows, automations, bookings, chat_approvals, coupons, device_link, email_in, sso, teams, trade, first_win, gst, approvals, assistant, audit, auth, billing, board, compliance, connectors, dashboard, invoices, kitchen, knowledge, leads,
                                 notice, orgs, partners, payments, privacy, push, reviews, sitelytc, skills, support, tally, task_boards, truhome, ventures, voice, whatsapp_chats, workflows)

UNSAFE_DEFAULTS = ("dev-only-secret",)


def check_production_config() -> None:
    s = get_settings()
    if s.environment != "production":
        return
    problems = []
    if any(s.jwt_secret.startswith(p) for p in UNSAFE_DEFAULTS):
        problems.append("JWT_SECRET is the development default")
    if not s.master_kek_b64:
        problems.append("MASTER_KEK_B64 is not set")
    if not s.sandbox_url:
        problems.append("SANDBOX_URL is not set (LocalSandbox has no network isolation)")
    if s.dispatch_mode != "arq":
        problems.append("DISPATCH_MODE must be 'arq' in production")
    if s.email_code_minutes > 15:
        problems.append("EMAIL_CODE_MINUTES must be 15 or less (sign-in and reset codes expire quickly)")
    if s.mail_transport != "smtp":
        problems.append(f"MAIL_TRANSPORT={s.mail_transport} doesn't deliver email (and 'log' would write sign-in,"
                        " reset and invitation codes to the logs, kept for a year); use smtp")
    if not s.client_ip_header.strip():
        problems.append("CLIENT_IP_HEADER is not set, so every visitor would share one rate-limit bucket"
                        " (behind Cloudflare Tunnel set CLIENT_IP_HEADER=cf-connecting-ip)")
    if problems:
        raise RuntimeError("refusing to start in production: " + "; ".join(problems))


@asynccontextmanager
async def lifespan(app: FastAPI):
    check_production_config()
    from kritvia_api import logredact
    logredact.install()          # emails and phone numbers masked in every log line (kept for a year)
    yield
    await dispose_engine()


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(title=s.app_name, version="1.0.0", lifespan=lifespan,
                  # No API explorer or schema in production: nothing to map the attack surface from.
                  docs_url=None if s.environment == "production" else "/docs",
                  openapi_url=None if s.environment == "production" else "/openapi.json",
                  redoc_url=None)
    origins = s.allowed_origins
    if s.environment == "production":
        # Browsers reach the API only through the web app's server, so production CORS allows
        # nothing but exact https:// origins; anything else in ALLOWED_ORIGINS is ignored.
        dropped = [o for o in origins if o == "*" or not o.startswith("https://")]
        if dropped:
            logging.getLogger("kritvia").warning("ignoring non-https CORS origins in production: %s", dropped)
        origins = [o for o in origins if o not in dropped]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
        max_age=600,
    )

    @app.exception_handler(DBAPIError)
    async def bad_text(request: Request, exc: DBAPIError):
        # Text with a NUL byte or an invalid encoding is refused as bad input (422), never a 500.
        if sqlstate(exc) in ("22021", "22P05"):
            return JSONResponse({"detail": "the text contains characters that aren't allowed"}, status_code=422)
        raise exc

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        h = response.headers
        h.setdefault("X-Content-Type-Options", "nosniff")
        h.setdefault("X-Frame-Options", "DENY")
        h.setdefault("Referrer-Policy", "no-referrer")
        h.setdefault("Cache-Control", "no-store")
        h.setdefault("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
        if s.environment == "production":
            h.setdefault("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
        return response

    from kritvia_api.apiclient import ApiClientMiddleware
    app.add_middleware(ApiClientMiddleware)       # /v1 prefix, Idempotency-Key, one error format (developer API)
    # Outermost: oversized bodies are refused before anything buffers or parses them.
    app.add_middleware(BodyLimitMiddleware)

    for r in (auth.router, orgs.router, ventures.router, leads.router, audit.router, workflows.router,
              approvals.router, sitelytc.router, knowledge.router, truhome.router, kitchen.router,
              compliance.router, connectors.router, dashboard.router, voice.router, billing.router, support.router, assistant.router, tally.router,
              board.router, push.router, notice.router, ai_models.router, task_boards.router, privacy.router,
              email_in.router, whatsapp_chats.router, invoices.router, chat_approvals.router, payments.router, first_win.router, gst.router, bookings.router, reviews.router, automations.router, partners.router, device_link.router, coupons.router, analytics.router, api_keys.router, custom_workflows.router, sso.router, trade.router, teams.router, skills.router, agent_team.router, browser.router, calls.router,
              bank.router, bills.router, campaigns.router, social.router, events.router, people.router, cash.router, ads.router, app_store.router):
        app.include_router(r)
    from kritvia_api.routers import exports, ses_feedback
    app.include_router(exports.router)            # organisation export (owners)
    app.include_router(ses_feedback.router)       # SES bounces and complaints -> suppression list

    @app.get("/healthz", tags=["ops"])
    async def healthz() -> dict:
        return {"status": "ok"}

    @app.get("/readyz", tags=["ops"])
    async def readyz(response: Response) -> dict:
        """The database and the run queue (Valkey). 503 with queue "down" when Valkey doesn't answer: runs
        can't start then, and the health watchdog restarts Valkey, not the API."""
        from sqlalchemy import text

        from kritvia_api.db.session import tenant_tx
        from kritvia_api.engine.context import get_services
        async with tenant_tx(None, "system") as conn:
            migrations = (await conn.execute(text("SELECT count(*) FROM schema_migrations"))).scalar()
        ping = getattr(get_services().dispatcher, "ping", None)
        queue = "n/a" if ping is None else ("ok" if await ping() else "down")
        if queue == "down":
            response.status_code = 503
        return {"status": "ok" if queue != "down" else "degraded", "migrations": migrations, "queue": queue}

    @app.get("/livez", tags=["ops"])
    async def livez(response: Response) -> dict:
        """Workers' heartbeats and the run queue, in counts (the watchdogs and the outside monitor read it).
        503 when a worker has gone quiet or runs are piling up, so a plain HTTP check notices."""
        from kritvia_api.db.session import tenant_tx
        from kritvia_api.services import watchdog
        async with tenant_tx(None, "system") as conn:
            st = await watchdog.status(conn)
        if not st["ok"]:
            response.status_code = 503
        return st

    return app


app = create_app()
