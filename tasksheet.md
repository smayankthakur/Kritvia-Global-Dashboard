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
| Phase 10: Developer Platform + Marketplace | In Progress | Public API v1 + webhooks, developer portal (tokens/webhooks/logs/docs/apps), marketplace app registry/install, OAuth app connect, runtime hooks, and app test console delivered. |

## Latest Update
- Date: 2026-02-16
- Phase: 6.4 (Scale Hardening v2) + 10.3.3 UI completion
- Result: Completed (step-level)
- Implemented:
  - Extended strict pagination enforcement and bounded key list queries.
  - Added role/org request limiting safeguards and preserved app command per-install rate limits.
  - Added simple async in-memory job queue for heavy compute/dispatch flows.
  - Added 60s TTL caching for CEO summary, health score, and insights list.
  - Normalized structured request logs (`requestId`, `orgId`, `userId`, `endpoint`, `durationMs`, `statusCode`).
  - Added env feature flags: `FEATURE_AI_ENABLED`, `FEATURE_MARKETPLACE_ENABLED`, `FEATURE_AUTOPILOT_ENABLED`.
  - Completed Developer Portal Apps tab for app test trigger, recent deliveries, command logs, and replay actions.
- Verification:
  - `npm run lint` passed.
  - `npm run build:api` passed.
  - `npm run build:web` passed.
