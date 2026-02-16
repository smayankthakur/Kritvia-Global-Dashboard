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
