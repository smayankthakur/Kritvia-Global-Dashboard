# Deployment

## Vercel (Frontend)

Use a dedicated Vercel project for `apps/web`.

- Root Directory: `apps/web`
- Install Command: `npm ci`
- Build Command: `npm run build`
- Output Directory: `.next`
- Framework Preset: `Next.js`

Notes:
- `apps/web/vercel.json` is configured for this mode.
- Do not set output to nested paths like `apps/web/apps/web/.next`.

## Render (API)

Use repo root as service root.

- Build Command: `npm ci --include=dev && npm run build:api`
- Start Command: `npm --workspace apps/api run migrate:deploy:render && npm run seed:api && npm run start:api`

Required env:
- `DATABASE_URL`
- `JWT_SECRET`

Jobs/Redis:
- `JOBS_ENABLED` defaults effectively to disabled when unset.
- If `JOBS_ENABLED=true` and `REDIS_URL` is missing, API still boots and workers are disabled with a warning.
- Set `STRICT_JOBS=true` only if you want startup/runtime to fail on missing Redis.
