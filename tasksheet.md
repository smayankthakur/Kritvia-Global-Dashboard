 # Kritviya Tasksheet

This file is the single source of truth for phase progress and task history.

## Mandatory Update Rule (Always Follow)
- Every new task must be logged in this file before closing work.
- Every phase change must update:
  - status
  - date
  - summary of what was implemented
  - key files/endpoints changed
  - verification notes
- Do not mark a phase complete unless its verification checks were run.
- If work is partial, mark it as `In Progress` and list blockers.

## Phase Tracker

| Phase | Status | Summary |
|---|---|---|
| Phase 1: Repo + Dev Foundation | Completed | Monorepo workspaces, Next.js web app, NestJS API health endpoint, shared package, docker-compose Postgres, root lint/format, README run guide. |
| Phase 2: Auth + Security Baseline | Completed | Prisma setup, migrations/seed (org/users/policies/activity logs), login + me endpoints, JWT + bcrypt + ValidationPipe, RBAC guard, secure test endpoints, Helmet/CORS/throttling/body-limit baseline. |
| Phase 3: Sales MVP | Completed | Companies/contacts/leads/deals models + CRUD, lead->deal conversion, org-scoped queries, RBAC enforcement, activity logs for sales mutations, sales UI pages in web. |
| Phase 4: Work Items + Ops | Completed | Work items model + APIs (list/create/update/transition/complete), Ops board/list/detail pages, deal won -> idempotent root work item creation, mutation audit logs. |
| Phase 5: Invoices (Money Loop) | Completed | Invoice model + APIs, send/lock/mark-paid/unlock flow with server-side lock enforcement, finance UI pages, invoice activity logging, RBAC + org scoping. |
| Phase 6: CEO Visibility + Hygiene + Nudges | Completed | CEO dashboard KPIs + bottlenecks, hygiene inbox, nudges create/list/resolve, notification feed, top-bar nudges UI, nudge throttling and entity/org checks, CORS handling fix. |
| Phase 7: Hardening/Polish | Completed | Hardening tracks delivered including secure session upgrade, request correlation/error standardization, pagination controls, and guardrail integration tests + CI. |
| Phase 8: Production Packaging + Deployment | In Progress | Production scripts, Docker packaging, migration-on-deploy flow, and deployment runbooks added for Vercel+Managed API and VPS Compose modes. |

## Latest Update
- Date: 2026-02-11
- Phase: 8 (Production Packaging + Deployment Artifacts + Runtime Audit Fixes)
- Result: In Progress
- Implemented:
  - Added production scripts at root (`build:*`, `start:*`, `migrate:deploy`, `seed:prod`).
  - Added API and Web multi-stage Dockerfiles for reproducible builds.
  - Added `docker-compose.prod.yml` with dedicated `migrate` one-off service before API startup.
  - Added production env coverage in `.env.example` and compatibility for:
    - `ACCESS_TOKEN_TTL` / `REFRESH_TOKEN_TTL`
    - `CORS_ORIGINS`
    - `NEXT_PUBLIC_API_BASE_URL`
  - Added deployment documentation for Option A (Vercel + managed API/DB) and Option B (VPS Compose).
  - Runtime audit fixes:
    - Fixed API production start entrypoint from `dist/main.js` to `dist/src/main.js`.
    - Fixed API Docker runtime CMD to `apps/api/dist/src/main.js`.
    - Split API TypeScript config for app vs tests (`types: ["node"]` in app tsconfig, dedicated `tsconfig.spec.json` for jest), preventing dev startup compile failures from test-only typings.
    - Added web-local ESLint config cleanup for consistent Next.js lint/build behavior.
- Verification:
  - Root `npm run build` passed.
  - Guardrail tests (`npm run test:ci`) passed.
  - Runtime smoke:
    - API `/health`, `/ready`, login, `/auth/me`, RBAC 403 path verified.
    - Web `/` and `/login` verified after clean restart.
