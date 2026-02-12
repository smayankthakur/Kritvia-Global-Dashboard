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

## Deployment

### Option A: Vercel (Web) + Managed API + Managed Postgres

Recommended stack:

- Web: Vercel (`apps/web`)
- API: Render/Railway/Fly.io/container platform (`apps/api`)
- Database: managed PostgreSQL (Neon/Supabase/RDS/etc.)

If you deploy API on Vercel, configure it as a separate Vercel project with Root Directory `apps/api`.

Required env vars:

API:

- `NODE_ENV=production`
- `API_PORT=4000`
- `DATABASE_URL=postgresql://...`
- `JWT_SECRET=...`
- `ACCESS_TOKEN_TTL=15m`
- `REFRESH_TOKEN_TTL=7d`
- `CORS_ORIGINS=https://your-web-domain.com`
- `COOKIE_SECURE=true`
- `COOKIE_DOMAIN=.your-domain.com` (optional)

WEB:

- `NEXT_PUBLIC_API_BASE_URL=https://api.yourdomain.com`

### API on Vercel (separate project)

Project setup:

- Root Directory: `apps/api`
- Framework Preset: `Other`
- Build Command: `npm run build --workspace @kritviya/api`
- Install Command: `npm install`
- Output Directory: leave empty

Required env vars in API Vercel project:

- `DATABASE_URL=postgresql://...`
- `JWT_SECRET=...`
- `NODE_ENV=production`
- `CORS_ORIGINS=https://your-web.vercel.app,https://your-custom-domain.com`
- `COOKIE_SECURE=true`
- `COOKIE_DOMAIN=` (optional)
- `ACCESS_TOKEN_TTL=15m`
- `REFRESH_TOKEN_TTL=7d`

Required env vars in Web Vercel project:

- `NEXT_PUBLIC_API_BASE_URL=https://<your-api-vercel-domain>`

Notes:

- Do not use `http://localhost:4000` in Vercel env.
- API routes are served by `apps/api/api/index.ts` via `apps/api/vercel.json`.
- Run Prisma migrations against production DB before first traffic:
  - `npm run migrate:deploy`

Deploy sequence:

1. Build API image or deploy API source.
2. Run migrations before traffic cutover:
   - `npm run migrate:deploy`
3. Deploy API and confirm:
   - `GET /health` returns 200
   - `GET /ready` returns 200
4. Deploy web on Vercel with `NEXT_PUBLIC_API_BASE_URL` set.

Rollback:

1. Re-deploy previous API release/image tag.
2. Re-deploy previous Vercel deployment.
3. Keep DB backups/snapshots; roll DB only if a migration explicitly requires rollback.

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
