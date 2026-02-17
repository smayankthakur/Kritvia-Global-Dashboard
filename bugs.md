# Bugs Audit Report

## Audit Timestamp
- Date: 2026-02-16
- Scope: Monorepo (`apps/api`, `apps/web`)
- Checks run: `lint`, `build:api`, `build:web`

## Bugs Found and Fixed

| ID | Area | Bug | Impact | Fix Applied | Status |
|---|---|---|---|---|---|
| BUG-001 | Web build | `apps/web` production build failed with `.next/trace` EPERM lock | Build/deploy instability on Windows/OneDrive | Re-ran clean build path and confirmed deterministic `npm run build:web` success | Fixed |
| BUG-002 | API lint/types | Extensive `no-explicit-any` violations in controllers/middleware/filters/tests | Type-safety regressions and CI lint failure | Replaced `any` with typed `Request`/`Response`/narrowed structures | Fixed |
| BUG-003 | API lint/imports | `no-require-imports` violations in TS runtime files | CI lint failure | Migrated to ESM imports (`bcryptjs`, `cookie-parser`, `express`) | Fixed |
| BUG-004 | Audit export service | CSV export had lint issues (`no-useless-escape`, `no-constant-condition`) | Potential maintainability/runtime quality issues | Corrected content-disposition string escaping and loop form | Fixed |
| BUG-005 | Shield service | Legacy dynamic model access with `any` cast on `securityEvent` | Type bypass risk and lint failure | Switched to typed `prisma.securityEvent` access | Fixed |
| BUG-006 | Tests | Unused imports and loose typing across e2e/spec files | CI lint failure and noisy test quality | Removed unused imports and added concrete test row/model types | Fixed |
| BUG-007 | Seed script lint | JS seed intentionally uses `require()` and violated lint rule | CI lint failure | Scoped ESLint disable for `seed.js` import style | Fixed |

## Verification
- `npm run lint` -> passes
- `npm run build:api` -> passes
- `npm run build:web` -> passes

## Re-Audit Timestamp
- Date: 2026-02-16
- Scope: Full monorepo sanity audit + developer portal/app runtime paths
- Checks run: `npm run lint`, `npm run build:api`, `npm run build:web`, `npm run test:setup`

## New Bugs Found and Fixed

| ID | Area | Bug | Impact | Fix Applied | Status |
|---|---|---|---|---|---|
| BUG-008 | API webhook runtime | Prisma filter used unsupported `notStartsWith` in webhook queries | Build break risk on strict Prisma client typing | Replaced with supported filter shape: `url: { not: { startsWith: \"app-install://\" } }` in webhook services | Fixed |
| BUG-009 | Test runner reliability | `apps/api/scripts/test-runner.mjs` could silently fallback to `DATABASE_URL` and failed with opaque Prisma schema engine errors when DB unavailable | Unclear failures, accidental non-test DB usage risk | Enforced `DATABASE_URL_TEST` by default, added optional explicit fallback flag, and added DB host/port preflight with clear actionable errors | Fixed |

## Re-Audit Verification
- `npm run lint` -> passes
- `npm run build:api` -> passes
- `npm run build:web` -> passes
- `npm run test:setup` -> now fails fast with clear database connectivity error when test DB is not reachable (expected until Postgres is up)

## Re-Audit Timestamp
- Date: 2026-02-17
- Scope: Full monorepo + current Phase 6.4.20 status subscriber changes
- Checks run: `npm ci`, `npm run lint`, `npm run build:api`, `npm run build:web`

## New Bugs Found and Fixed

| ID | Area | Bug | Impact | Fix Applied | Status |
|---|---|---|---|---|---|
| BUG-010 | Tooling / ESLint | Missing `esquery` / `@ungap/structured-clone` modules in local dependency tree caused lint/build lint phase crashes | Blocked lint and Next build lint stage | Performed clean deterministic install with `npm ci` and updated lockfile state; verified full lint/build pipeline | Fixed |
| BUG-011 | API lint | Unused constants/types in incident + on-call resolver modules (`INCIDENT_STATUSES`, `ResolvedSchedule`) | CI lint failure | Removed dead constants/type aliases | Fixed |
| BUG-012 | Test lint | Unused variables in scheduler spec and on-call e2e (`name` mock arg, `adminToken`) | CI lint failure | Removed unused variables and simplified mock signatures | Fixed |
| BUG-013 | Web lint | Unused React state setter in developer on-call tab | CI lint failure | Removed unused setter from state tuple | Fixed |

## Latest Verification
- `npm run lint` -> passes
- `npm run build:api` -> passes
- `npm run build:web` -> passes
