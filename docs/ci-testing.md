# CI Testing Strategy

This repo uses two API test paths:

- Fast/default CI path (required for push/PR)
- Full E2E path (optional, non-blocking, manual/nightly)

## Default CI (stable, required)

The required GitHub Actions jobs run:

1. `api-typecheck` -> `npm --workspace apps/api run typecheck`
2. `api-lint` -> `npm --workspace apps/api run lint`
3. `api-unit` -> `npm --workspace apps/api run test:ci` with:
   - `CI_FAST=true`
   - `RUN_E2E=false`

In fast mode, `apps/api/scripts/test-runner.mjs` runs:

- TypeScript typecheck
- ESLint
- Jest unit config (`test/jest-unit.config.js`) with `--passWithNoTests`

This path does not require Postgres/Redis.

## E2E CI (optional, non-blocking)

The `api-e2e` job runs only on:

- `workflow_dispatch`
- nightly `schedule`

It is configured with `continue-on-error: true`.

To run E2E in CI you must provide:

- `CI_E2E_DATABASE_URL` GitHub secret (used as `DATABASE_URL_TEST`)

`RUN_E2E=true` requires a non-localhost database URL by design.

## Local commands

### Fast checks (same as default CI behavior)

```bash
npm --workspace apps/api run typecheck
npm --workspace apps/api run lint
CI_FAST=true RUN_E2E=false npm --workspace apps/api run test:ci
```

### E2E locally (real DB required)

```bash
RUN_E2E=true DATABASE_URL_TEST=postgresql://<user>:<pass>@<host>:5432/<db> npm --workspace apps/api run test:ci
```

Or run direct scripts:

```bash
npm --workspace apps/api run test:setup
npm --workspace apps/api run test:e2e
```

## Required env vars for E2E

- `RUN_E2E=true`
- `DATABASE_URL_TEST=<non-localhost-postgres-url>`
- `JWT_SECRET` (dummy value is fine for tests)
- `JOBS_ENABLED=false` (set by runner in test env)
