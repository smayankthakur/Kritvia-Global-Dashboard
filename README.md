# Kritviya (Execution OS) - Phase 8 Production Packaging

## Prerequisites

- Node.js 20+
- npm 10+
- Docker Desktop (or Docker Engine + Compose plugin)

## Setup

1. Create env file:
   ```bash
   cp .env.example .env
   ```
   Windows PowerShell:
   ```powershell
   Copy-Item .env.example .env
   ```
2. Install dependencies:
   ```bash
   npm install
   ```

## Run (Fresh DB)

1. Start Postgres:
   ```bash
   npm run dev:db
   ```
   This starts Postgres from `infra/docker-compose.yml`. For Phase 6.4.11 job workers, start Redis too:
   ```bash
   docker compose --env-file .env -f infra/docker-compose.yml up -d postgres redis
   ```
2. Apply migrations:
   ```bash
   npm run db:migrate
   ```
3. Seed demo org/users:
   ```bash
   npm run db:seed
   ```
4. Start API:
   ```bash
   npm run dev:api
   ```
5. Start Web:
   ```bash
   npm run dev:web
   ```

Optional API + Web in one terminal:

```bash
npm run dev
```

## Production Scripts

From repo root:

- `npm run build:api`
- `npm run build:web`
- `npm run build` (api + web)
- `npm run migrate:deploy` (Prisma `migrate deploy`)
- `npm run seed:api` (Prisma seed via `apps/api/prisma/seed.ts`)
- `npm run seed:prod` (optional; idempotent demo seed)
- `npm run start:api` (runs built API)
- `npm run start:web` (runs built web)
- `npm run start:prod` (migrate first, then run API + web)

## Integration Guardrail Tests (Phase 7.4)

Test DB env:

- `DATABASE_URL_TEST=postgresql://kritviya:kritviya@localhost:5432/kritviya_test`

Run setup once (migrate + seed test DB):

```bash
npm run test:setup
```

Run integration tests:

```bash
npm run test
```

CI-equivalent local run (reset + migrate + seed + tests):

```bash
npm run test:ci
```

Deterministic test users (password for all: `kritviyaTest123!`):

- `admina@test.kritviya.local`
- `ceoa@test.kritviya.local`
- `opsa@test.kritviya.local`
- `salesa@test.kritviya.local`
- `financea@test.kritviya.local`
- `adminb@test.kritviya.local`

## Local Postgres Fallback (If Docker/WSL Is Unavailable)

Use this only if `npm run dev:db` fails because Docker engine is unavailable.

1. Install Scoop (PowerShell):
   ```powershell
   Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
   iwr -useb get.scoop.sh | iex
   ```
2. Install PostgreSQL:
   ```powershell
   & "$env:USERPROFILE\scoop\shims\scoop.cmd" install postgresql
   & "$env:USERPROFILE\scoop\shims\scoop.cmd" reset postgresql
   ```
3. Initialize a local cluster (one-time):
   ```powershell
   $pgRoot = "$env:USERPROFILE\scoop\apps\postgresql\18.1\pgsql"
   $dataDir = "$env:USERPROFILE\scoop\apps\postgresql\18.1\data_kritviya"
   New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
   & "$pgRoot\bin\initdb.exe" -D $dataDir -L "$pgRoot\share" --username=postgres --encoding=UTF8 --locale=C
   ```
4. Start PostgreSQL on `5432`:
   ```powershell
   & "$env:USERPROFILE\scoop\apps\postgresql\18.1\pgsql\bin\pg_ctl.exe" `
     -D "$env:USERPROFILE\scoop\apps\postgresql\18.1\data_kritviya" `
     -l "$env:USERPROFILE\scoop\apps\postgresql\18.1\data_kritviya\logfile" `
     -o "-p 5432" start
   ```
5. Create DB/user expected by `.env` (one-time):
   ```powershell
   $psql = "$env:USERPROFILE\scoop\apps\postgresql\18.1\pgsql\bin\psql.exe"
   & $psql -U postgres -d postgres -c "CREATE ROLE kritviya LOGIN PASSWORD 'kritviya';" 2>$null
   & $psql -U postgres -d postgres -c "ALTER ROLE kritviya WITH LOGIN PASSWORD 'kritviya';"
   & $psql -U postgres -d postgres -c "CREATE DATABASE kritviya OWNER kritviya;" 2>$null
   & $psql -U postgres -d postgres -c "GRANT ALL PRIVILEGES ON DATABASE kritviya TO kritviya;"
   ```
6. Run app DB setup:
   ```powershell
   npm run db:migrate
   npm run db:seed
   ```

Daily start (fallback mode):

```powershell
# DB
& "$env:USERPROFILE\scoop\apps\postgresql\18.1\pgsql\bin\pg_ctl.exe" `
  -D "$env:USERPROFILE\scoop\apps\postgresql\18.1\data_kritviya" `
  -l "$env:USERPROFILE\scoop\apps\postgresql\18.1\data_kritviya\logfile" `
  -o "-p 5432" start

# API + Web
npm run dev:api
npm run dev:web
```

Daily stop (fallback mode):

```powershell
& "$env:USERPROFILE\scoop\apps\postgresql\18.1\pgsql\bin\pg_ctl.exe" `
  -D "$env:USERPROFILE\scoop\apps\postgresql\18.1\data_kritviya" stop
```

## Demo Credentials

Password for all demo users:

- `kritviya123`

Users:

- `ceo@demo.kritviya.local` (CEO, read-only for sales)
- `ops@demo.kritviya.local` (OPS, forbidden)
- `sales@demo.kritviya.local` (SALES)
- `finance@demo.kritviya.local` (FINANCE, forbidden)
- `admin@demo.kritviya.local` (ADMIN)

## URLs

- Web: http://localhost:3000
- API: http://localhost:4000
- Liveness: `GET /health`
- Readiness: `GET /ready` (checks DB connectivity)

Monitoring recommendation:

- Use `/health` for liveness (container/process alive).
- Use `/ready` for readiness (DB connectivity confirmed).
- Alert if `/ready` is failing while `/health` is passing.

## Request ID Correlation

- API accepts optional `X-Request-Id` request header (UUID v4).
- If absent/invalid, API generates a UUID v4.
- API always returns `X-Request-Id` response header.
- Error responses include `error.requestId` for correlation with server logs.

## Error Response Shape

All API errors return:

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "Forbidden resource",
    "requestId": "3a4b5c6d-7e8f-4a1b-9c2d-0e1f2a3b4c5d"
  }
}
```

Validation errors return:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request.",
    "details": [
      { "field": "email", "issues": ["email must be an email"] }
    ],
    "requestId": "3a4b5c6d-7e8f-4a1b-9c2d-0e1f2a3b4c5d"
  }
}
```

## Core Endpoints

Auth:

- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`
- `GET /auth/me`

Companies:

- `GET /companies`
- `POST /companies`
- `GET /companies/:id`
- `PATCH /companies/:id`

Contacts:

- `GET /companies/:companyId/contacts`
- `POST /contacts`
- `PATCH /contacts/:id`

Leads:

- `GET /leads?stage=`
- `POST /leads`
- `PATCH /leads/:id`
- `POST /leads/:id/convert-to-deal`

Deals:

- `GET /deals?stage=`
- `POST /deals`
- `PATCH /deals/:id`
- `POST /deals/:id/mark-won`
- `POST /deals/:id/mark-lost`
- `GET /deals/:id/timeline`

CEO Health Score:

- `GET /ceo/health-score` (CEO, ADMIN)
- `GET /ceo/health-score/explain?date=YYYY-MM-DD` (CEO, ADMIN)

AI Insights:

- `POST /ai/compute-insights` (ADMIN, or `X-JOBS-SECRET` + `X-ORG-ID`)
- `GET /ceo/insights` (CEO, ADMIN)
- `POST /ceo/insights/:id/resolve` (CEO, ADMIN)

AI Actions:

- `POST /ai/compute-actions` (ADMIN, or `X-JOBS-SECRET` + `X-ORG-ID`)
- `GET /ai/actions` (CEO, ADMIN)
- `POST /ai/actions/:id/approve` (CEO, ADMIN)
- `POST /ai/actions/:id/execute` (CEO, ADMIN, OPS restrictions apply)
- `POST /ai/actions/:id/undo` (CEO, ADMIN)

Public API v1 (service account tokens only):

- `GET /api/v1/users` (`read:users`)
- `GET /api/v1/deals` (`read:deals`)
- `GET /api/v1/invoices` (`read:invoices`)
- `GET /api/v1/work-items` (`read:work-items`)
- `GET /api/v1/insights` (`read:insights`)
- `GET /api/v1/actions` (`read:actions`)
- Response header: `X-Kritviya-Version: 1`

LLM Reports:

- `POST /llm/reports/ceo-daily-brief` (CEO, ADMIN, rate-limited)
- `POST /llm/reports/score-drop-explain` (CEO, ADMIN, rate-limited)
- `GET /llm/reports?type=&limit=` (CEO, ADMIN)

Jobs:

- `POST /jobs/compute-health-score` (ADMIN)
- `POST /jobs/run` (ADMIN or `X-JOBS-SECRET` when `JOBS_SECRET` is configured)
- `POST /jobs/retention/run` (ADMIN or `X-JOBS-SECRET` when `JOBS_SECRET` is configured)

Settings:

- `GET /settings/policies` (CEO, ADMIN)
- `PUT /settings/policies` (CEO, ADMIN)
- `GET /org/audit/export?from=YYYY-MM-DD&to=YYYY-MM-DD&format=csv` (CEO, ADMIN, enterpriseControlsEnabled required)
- `POST /org/api-tokens` (CEO, ADMIN, enterpriseControlsEnabled required)
- `GET /org/api-tokens` (CEO, ADMIN, enterpriseControlsEnabled required)
- `DELETE /org/api-tokens/:id` (CEO, ADMIN, enterpriseControlsEnabled required)

Billing:

- `GET /billing/plan` (CEO, ADMIN)
- `POST /billing/create-subscription` (CEO, ADMIN)
- `POST /billing/webhook` (no auth, Razorpay signature required)
- `GET /billing/portal` (CEO, ADMIN)
- `GET /org/usage` (CEO, ADMIN)

## Org Execution Score (Phase 2.1)

Endpoint usage:

- `GET /ceo/health-score` (CEO, ADMIN): returns today's score snapshot for the org.
- If today's snapshot does not exist, API computes and upserts it first.
- `GET /ceo/health-score/explain?date=YYYY-MM-DD`: compares target date snapshot vs previous day and returns negative drivers + deep links.
- `POST /jobs/compute-health-score` (ADMIN): forces compute/upsert for today (idempotent by `orgId + dateKey`).

Scoring formula:

- Start at `100`
- `overdueWorkPenalty = min(40, round(overdueWorkPct * 40))`
- `overdueInvoicePenalty = min(30, round(overdueInvoicePct * 30))`
- `staleDealsPenalty = min(20, round(staleDealsPct * 20))`
- `hygienePenalty = min(10, round(min(hygieneCount, 50) / 50 * 10))`
- `score = max(0, 100 - sum(penalties))`

Render notes:

- No extra env vars are required beyond existing API env (`DATABASE_URL`, `JWT_SECRET`, etc.).
- Ensure migrations run on deploy (`npm run migrate:deploy`) so `org_health_snapshots` exists.
- Verify in production:
  - `GET https://<render-api>/health`
  - `GET https://<render-api>/ready`
  - Authenticated `GET https://<render-api>/ceo/health-score`

Work Items:

- `GET /work-items?status=&assignedTo=&due=overdue|today|week|all`
- `POST /work-items`
- `GET /work-items/:id`
- `PATCH /work-items/:id`
- `POST /work-items/:id/transition`
- `POST /work-items/:id/complete`
- `GET /work-items/:id/activity`

Invoices:

- `GET /invoices?status=&companyId=&dealId=`
- `POST /invoices`
- `GET /invoices/:id`
- `PATCH /invoices/:id`
- `POST /invoices/:id/send`
- `POST /invoices/:id/mark-paid`
- `POST /invoices/:id/unlock`
- `GET /invoices/:id/activity`

## Security Baseline (Sudarshan Shield)

- bcrypt password hashing
- JWT auth (`HS256`) + expiry from env
- HttpOnly refresh token cookie session with refresh-token rotation
- Refresh tokens stored hashed in DB (`refresh_tokens.token_hash`)
- ValidationPipe + DTO validation on inputs
- Server-side RBAC guards
- Org scoping on all auth/sales queries
- Helmet enabled
- CORS allowlist via `CORS_ORIGIN`
- Login rate limiting on `POST /auth/login`
- Request body limit `1mb`
- Production-safe exception filter

## Auth Flow (Phase 7)

1. `POST /auth/login` validates credentials and returns a short-lived access token in JSON.
2. API also sets `kritviya_refresh_token` as an HttpOnly cookie.
3. Web stores access token only in memory (not localStorage/sessionStorage).
4. On `401`, web calls `POST /auth/refresh` (cookie-based) and retries once.
5. `POST /auth/logout` revokes current refresh token and clears refresh cookie.

## Auth/Session Environment Variables

- `ACCESS_TOKEN_TTL=15m` (preferred)
- `REFRESH_TOKEN_TTL=7d` (preferred)
- `JWT_EXPIRES_IN=15m` (legacy fallback)
- `REFRESH_TOKEN_TTL_DAYS=7` (legacy fallback)
- `COOKIE_SECURE=true` in production with HTTPS
- `COOKIE_DOMAIN=` (optional)
- `TRUST_PROXY=false` (set `true` behind reverse proxy)
- `RAZORPAY_KEY_ID=`
- `RAZORPAY_KEY_SECRET=`
- `RAZORPAY_WEBHOOK_SECRET=`
- `RAZORPAY_PLAN_STARTER=`
- `RAZORPAY_PLAN_GROWTH=`
- `RAZORPAY_PLAN_PRO=`
- `RAZORPAY_PLAN_ENTERPRISE=`
- `LLM_ENABLED=false`
- `LLM_PROVIDER=mock|generic-http`
- `LLM_API_KEY=`
- `LLM_MODEL=`
- `LLM_ENDPOINT=`
- `WEB_BASE_URL=`
- `API_BASE_URL=`

## Deployment

### Option A (Recommended): Vercel (Web) + Render (API) + Managed Postgres

Use this stack for reliability with NestJS + Prisma:

- Web: Vercel (`apps/web`)
- API: Render Web Service (`apps/api`)
- Database: Render Postgres (or other managed Postgres)

Note: backend deployment on Vercel serverless is intentionally not used here.

### Render API Configuration (Copy/Paste)

Render service:

- Type: `Web Service`
- Repo: this repo
- Root Directory: `.` (repo root)
- Build Command: `npm ci --include=dev && npm run build:api`
- Start Command: `npm --workspace apps/api run migrate:deploy:render && npm run seed:api && npm run start:api`
- Health Check Path: `/health`
- Readiness Check Path: `/ready` (optional separate monitor)

Important for manual Render services:

- If you configure service commands in the Render UI, set build exactly to:
  - `npm ci --include=dev && npm run build:api`
- Existing manually-created Render services keep the Build/Start commands saved in the dashboard.
- Updating `render.yaml` in git does not automatically overwrite those dashboard commands unless you deploy via Blueprint sync/recreate.
- Set Start command in Render dashboard exactly to:
  - `npm --workspace apps/api run migrate:deploy:render && npm run seed:api && npm run start:api`
- Or deploy via Blueprint (`render.yaml`) so this command is applied automatically.
- `NODE_ENV=production` can cause devDependencies to be omitted during install.
  Using `--include=dev` (or setting `NPM_CONFIG_PRODUCTION=false`) ensures TypeScript build dependencies are installed.

Render backend env vars:

- `NODE_ENV=production`
- `DATABASE_URL=<render-postgres-url>`
- `JWT_SECRET=<strong-random-secret>`
- `ACCESS_TOKEN_TTL=900s`
- `REFRESH_TOKEN_TTL=7d`
- `COOKIE_SECURE=true`
- `COOKIE_SAMESITE=none`
- `COOKIE_DOMAIN=` (leave empty unless you need a custom cookie domain)
- `CORS_ORIGINS=https://executiv-dashboard.vercel.app`
- `RAZORPAY_KEY_ID=<rzp_live_or_test_key_id>`
- `RAZORPAY_KEY_SECRET=<razorpay_key_secret>`
- `RAZORPAY_WEBHOOK_SECRET=<razorpay_webhook_secret>`
- `RAZORPAY_PLAN_STARTER=<plan_id_for_starter>`
- `RAZORPAY_PLAN_GROWTH=<plan_id_for_growth>`
- `RAZORPAY_PLAN_PRO=<plan_id_for_pro>`
- `RAZORPAY_PLAN_ENTERPRISE=<plan_id_for_enterprise>`
- `WEB_BASE_URL=https://executiv-dashboard.vercel.app`
- `API_BASE_URL=https://<render-api-domain>`
- `REDIS_URL=redis://default:<password>@<redis-host>:6379`
- `JOBS_ENABLED=true`
- `JOBS_WORKER_MODE=api` (API service) / `worker` (worker service)
- `JOBS_CONCURRENCY_AI=2`
- `JOBS_CONCURRENCY_WEBHOOKS=5`
- `JOBS_CONCURRENCY_MAINT=1`
- `SCHEDULER_ENABLED=true`
- `SCHEDULER_MODE=worker` (recommended so only worker registers repeatables)
- `SCHED_TZ=UTC`
- `SCHED_HEALTH_CRON=0 2 * * *`
- `SCHED_INSIGHTS_CRON=10 2 * * *`
- `SCHED_ACTIONS_CRON=20 2 * * *`
- `SCHED_BRIEFING_CRON=30 6 * * *`
- `SCHED_INVOICE_SCAN_CRON=0 * * * *`
- `SCHED_RETENTION_CRON=0 3 * * 0`
- `SCHED_MAX_ORGS_PER_RUN=200`

Optional dedicated worker service on Render:

- Service type: `Worker`
- Build Command: `npm ci --include=dev && npm run build:api`
- Start Command: `JOBS_ENABLED=true JOBS_WORKER_MODE=worker node apps/api/dist/main.js`
- Worker `/health` listens on `PORT` and returns `{ status:"ok", service:"api-worker" }`
- Add scheduler env on worker:
  - `SCHEDULER_ENABLED=true`
  - `SCHEDULER_MODE=worker`

### Vercel Web Configuration (Copy/Paste)

Vercel web project:

- Root Directory: `apps/web`
- Framework: `Next.js`
- Build Command: default
- Output Directory: default

Vercel frontend env vars:

- `NEXT_PUBLIC_API_BASE_URL=https://<your-render-api-domain>`

Example:

- `NEXT_PUBLIC_API_BASE_URL=https://execution-os-api.onrender.com`

Do not set `localhost` in Vercel env.

### Do This Now (Step-by-Step)

1. Create Render Postgres database and copy `DATABASE_URL`.
2. Create Render Web Service for API with the commands above.
3. Set all API env vars in Render.
4. Run migrations and seed demo users on production DB:
   - `npm run migrate:deploy`
   - `npm run seed:api`
5. Open and confirm:
   - `https://<render-api-domain>/health`
   - `https://<render-api-domain>/ready`
6. In Vercel (web project), set:
   - `NEXT_PUBLIC_API_BASE_URL=https://<render-api-domain>`
7. Redeploy frontend on Vercel.
8. Test login at:
   - `https://executiv-dashboard.vercel.app`
9. Configure Razorpay webhook:
   - URL: `https://<render-api-domain>/billing/webhook`
   - Secret: same as `RAZORPAY_WEBHOOK_SECRET`
   - Events: `subscription.activated`, `subscription.charged`, `subscription.halted`, `subscription.paused`, `subscription.cancelled`, `payment.failed`
10. Verify billing:
   - Open `/billing` as CEO/ADMIN and click `Upgrade`
   - Complete Razorpay checkout
   - Re-open `/billing` and confirm status updates via webhook

### Render Build Simulation (Local From Repo Root)

Use these exact commands to mirror Render behavior:

1. `npm ci`
2. `npm run build:api`
3. `npm run migrate:deploy`
4. `npm run seed:api`
5. `npm run start:api`
6. Verify:
   - `http://localhost:4000/health`
   - `http://localhost:4000/ready`

### Render: Prisma P3009 recovery

If Render fails with Prisma `P3009` on migration `20260218150000_phase6421_whitelabel_status`, use one of these paths:

Why this happens:
- Prisma `P3009` means a migration is marked failed in `prisma_migrations`.
- `migrate deploy` will refuse all future migrations until that failed row is resolved.

Automatic Render self-heal (configured in `render.yaml`):
- Start command runs:
  - `npm --workspace apps/api run migrate:deploy:render`
- Script behavior:
  - runs `npx prisma migrate deploy --schema prisma/schema.prisma`
  - if output contains `P3009` + `20260218150000_phase6421_whitelabel_status` and `ALLOW_MIGRATION_RECOVERY=true`, runs:
    - `npx prisma migrate resolve --schema prisma/schema.prisma --rolled-back 20260218150000_phase6421_whitelabel_status`
  - retries deploy once
  - fails fast for any other migration failure

1. Disposable DB (simplest):
   - Reset/recreate the Render Postgres database.
   - Redeploy or run:
     - `npx prisma migrate deploy`
   - Safe when environment is early-stage/demo and data loss is acceptable.

2. Preserve DB data:
   - Inspect migration state:
     - `npx prisma migrate status`
   - Manual recovery commands for this exact migration:
     - `npx prisma migrate resolve --schema apps/api/prisma/schema.prisma --rolled-back 20260218150000_phase6421_whitelabel_status`
     - `npx prisma migrate deploy --schema apps/api/prisma/schema.prisma`
   - Use only after verifying DB state for this migration (columns/indexes/constraints) is consistent.

Recommended deploy command remains:
- `npx prisma migrate deploy`

Render checklist:
1. In Render dashboard, verify Build Command is `npm ci --include=dev && npm run build:api`.
2. In Render dashboard, verify Start Command is `npm --workspace apps/api run migrate:deploy:render && npm run seed:api && npm run start:api`.
3. Set env `ALLOW_MIGRATION_RECOVERY=true` on the API service.
4. Redeploy and confirm startup logs show:
   - `ALLOW_MIGRATION_RECOVERY=true`
   - expected render start command banner
5. If deploy still fails on non-target migration, stop auto-recovery and use manual Prisma recovery for that migration.

### Option B: VPS Docker Compose (Self-Hosted)

Files:

- `apps/api/Dockerfile`
- `apps/web/Dockerfile`
- `docker-compose.prod.yml`

Required env vars in `.env`:

- `NODE_ENV=production`
- `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`
- `DATABASE_URL`
- `API_PORT=4000`
- `WEB_PORT=3000`
- `JWT_SECRET`
- `ACCESS_TOKEN_TTL`
- `REFRESH_TOKEN_TTL`
- `CORS_ORIGINS`
- `COOKIE_SECURE=true`
- `COOKIE_SAMESITE=none`
- `COOKIE_DOMAIN` (optional)
- `NEXT_PUBLIC_API_BASE_URL`

Deploy steps on VPS:

1. Build and start:
   - `docker compose --env-file .env -f docker-compose.prod.yml up -d --build`
2. Migrations run via one-off `migrate` service before API starts.
3. Verify:
   - `curl http://localhost:4000/health`
   - `curl http://localhost:4000/ready`
   - `curl http://localhost:3000`

Reverse proxy:

- Put Nginx/Caddy in front of `web` and `api` for TLS and routing.
- Route `https://yourdomain.com` -> web and `https://api.yourdomain.com` -> api.

Rollback:

1. Re-deploy previous image tags in `docker-compose.prod.yml`.
2. `docker compose -f docker-compose.prod.yml up -d`
3. Re-check `/health` and `/ready`.

## Troubleshooting

- Docker unavailable:
  - Install/start Docker and rerun `npm run dev:db`.
- DB connection failures:
  - Ensure Postgres is listening on `localhost:5432`.
- Migration/seed failures:
  - Verify `DATABASE_URL` in `.env`.
- Port conflicts:
  - Web `3000`, API `4000`, DB `5432` must be free.
- Production CORS issues:
  - Ensure `CORS_ORIGINS` includes exact web origins (scheme + domain).
- Login fails on production:
  - Ensure web env has `NEXT_PUBLIC_API_BASE_URL` set to your Render API URL.
  - Ensure API has `CORS_ORIGINS=https://executiv-dashboard.vercel.app`.
  - Ensure API cookie settings are:
    - `COOKIE_SECURE=true`
    - `COOKIE_SAMESITE=none`
- `GET /ready` fails:
  - Check `DATABASE_URL`.
  - Check migrations were run: `npm run migrate:deploy`.
- Repeated `401` / refresh loop:
  - Refresh cookie is blocked by browser when SameSite/Secure is wrong.
  - Set `COOKIE_SAMESITE=none` and `COOKIE_SECURE=true` on API.
11. Verify job queues:
   - `POST https://<render-api-domain>/ai/compute-insights` returns `{ queue, jobId, status:"queued" }`
   - `GET https://<render-api-domain>/jobs/status/ai/<jobId>` shows state

## White-Labeled Status Pages (Phase 6.4.21)

Org settings APIs (CEO/ADMIN):
- `GET /org/status/settings`
- `PATCH /org/status/settings`
- `POST /org/status/domain/request`
- `POST /org/status/domain/verify`

Public status routes:
- `/status/o/<orgSlug>`
- `/status/o/<orgSlug>/incidents`
- `/status/o/<orgSlug>/incidents/<incidentSlug>`

Private token mode usage:
- If org visibility is `PRIVATE_TOKEN`, pass `token` query:
  - `/status/o/<orgSlug>?token=<status-access-token>`

Private SSO mode (magic link):
- Set org visibility to `PRIVATE_SSO`
- Configure allowed domains in status settings
- Required env:
  - `STATUS_SESSION_SECRET`
  - `STATUS_BASE_URL`
- Auth endpoints:
  - `POST /status-auth/request-link`
  - `GET /status-auth/verify`
  - `POST /status-auth/logout`

Custom domain TXT setup:
1. `POST /org/status/domain/request` with `{ "domain": "status.acme.com" }`
2. Add TXT record:
   - Name: `_kritviya-status.status.acme.com`
   - Value: `<token from API response>`
3. `POST /org/status/domain/verify`
4. Optionally resolve domain via `GET /status/resolve-domain?host=status.acme.com`
