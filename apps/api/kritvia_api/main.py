from contextlib import asynccontextmanager

import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DBAPIError

from kritvia_api.bodylimit import BodyLimitMiddleware
from kritvia_api.config import get_settings
from kritvia_api.db.session import dispose_engine
from kritvia_api.errors import sqlstate
from kritvia_api.routers import (ai_models, approvals, audit, auth, billing, board, compliance, connectors, dashboard, kitchen, knowledge, leads,
                                 notice, orgs, privacy, push, sitelytc, support, tally, task_boards, truhome, ventures, voice, workflows)

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
    if s.mail_transport == "log" and s.signup_open:
        problems.append("MAIL_TRANSPORT=log would write sign-in codes to the logs; use smtp, or set SIGNUP_OPEN=false")
    if problems:
        raise RuntimeError("refusing to start in production: " + "; ".join(problems))


@asynccontextmanager
async def lifespan(app: FastAPI):
    check_production_config()
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

    # Outermost: oversized bodies are refused before anything buffers or parses them.
    app.add_middleware(BodyLimitMiddleware)

    for r in (auth.router, orgs.router, ventures.router, leads.router, audit.router, workflows.router,
              approvals.router, sitelytc.router, knowledge.router, truhome.router, kitchen.router,
              compliance.router, connectors.router, dashboard.router, voice.router, billing.router, support.router, tally.router,
              board.router, push.router, notice.router, ai_models.router, task_boards.router, privacy.router):
        app.include_router(r)

    @app.get("/healthz", tags=["ops"])
    async def healthz() -> dict:
        return {"status": "ok"}

    @app.get("/readyz", tags=["ops"])
    async def readyz() -> dict:
        from sqlalchemy import text

        from kritvia_api.db.session import tenant_tx
        async with tenant_tx(None, "system") as conn:
            migrations = (await conn.execute(text("SELECT count(*) FROM schema_migrations"))).scalar()
        return {"status": "ok", "migrations": migrations}

    return app


app = create_app()
