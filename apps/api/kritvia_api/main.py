from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from kritvia_api.config import get_settings
from kritvia_api.db.session import dispose_engine
from kritvia_api.routers import (approvals, audit, auth, billing, board, compliance, connectors, dashboard, kitchen, knowledge, leads,
                                 orgs, push, sitelytc, support, tally, truhome, ventures, voice, workflows)

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
                  docs_url=None if s.environment == "production" else "/docs",
                  redoc_url=None)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=s.allowed_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

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

    for r in (auth.router, orgs.router, ventures.router, leads.router, audit.router, workflows.router,
              approvals.router, sitelytc.router, knowledge.router, truhome.router, kitchen.router,
              compliance.router, connectors.router, dashboard.router, voice.router, billing.router, support.router, tally.router,
              board.router, push.router):
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
