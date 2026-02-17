# Kritviya Phase Tracker

This sheet records which phases are completed and what was delivered in each phase.

## Completed Phases

| Phase | Status | Brief Introduction |
|---|---|---|
| Phase 1: Repo + Dev Foundation | Completed | Set up monorepo workspaces, web/api app scaffolds, shared package, local Postgres infra, and unified lint/format tooling. |
| Phase 2: Auth + Security Baseline | Completed | Implemented login/auth flow with JWT + bcrypt, org-scoped access, RBAC guards, validation, and Sudarshan Shield baseline controls. |
| Phase 3: Sales MVP | Completed | Added sales entities and flows (companies, contacts, leads, deals) with org scoping, RBAC, and audit logs. |
| Phase 4: Work Execution Layer | Completed | Introduced work items, ops views, and deal-to-work package linkage with mutation logging. |
| Phase 5: Finance Money Loop | Completed | Delivered invoice lifecycle (draft/send/lock/unlock/paid), finance screens, and server-side lock enforcement. |
| Phase 6: CEO Visibility + Intelligence | Completed | Built CEO dashboards and metrics (health score, explainers, revenue velocity, cashflow), hygiene/nudges, and action workflows. |
| Phase 7: Stabilization + Security Hardening | In Progress | Strengthened active org scoping, session/auth robustness, portfolio mode foundations, and reliability-focused improvements. |
| Phase 8: Billing + Commercialization | In Progress | Added plan/subscription foundations, Razorpay checkout + webhook sync, enterprise-gated audit CSV export, retention cleanup jobs, service account API tokens, per-token hourly rate limiting, scoped API token permissions, and API token security logging. |
| Phase 9: AI Intelligence Layer | In Progress | Added deterministic AI insight engine foundations with compute/list/resolve APIs and org-scoped actionable insight generation, backend AI Action Layer for proposal/approval/execution/undo workflows, CEO Action Mode AI Actions inbox UI, CEO Briefing panel UI, and Phase 9.3 LLM Explainability backend (LLMReport model, grounded context builder, cached JSON report endpoints with validation). |
| Phase 10: Platform Externalization | In Progress | Added Phase 10.1 Public API v1 foundations (`/api/v1/*`) with service-account-only authentication, scope enforcement, org scoping, response version header, version metadata in API token activity logs, Phase 10.1 webhook infrastructure (org-managed endpoints, signed delivery, retries, circuit breaker, event hooks from deals/invoices/work/AI modules), Phase 10.2.1 Developer Portal shell (`/developer`) with tabbed navigation, CEO/ADMIN access control, enterprise plan gating, sidebar integration, Phase 10.2.2 API Tokens tab (list/create/revoke, one-time token reveal, scoped/rate-limit inputs, and upgrade/IP/rate-limit error handling), Phase 10.2.3 Webhooks tab (list/create/delete, HTTPS URL validation, event multi-select, one-time secret reveal, and signature header instructions), Phase 10.2.4 webhook delivery observability (WebhookDelivery persistence per attempt + list/retry endpoints under org webhooks), Phase 10.2.4 Developer Logs tab UI (webhook delivery table with details/retry + API token usage log view from audit activity), Phase 10.2.5 protected OpenAPI JSON for Public API v1 (`/api/v1/openapi.json`, service-account scope `read:docs`/`admin:*`, public endpoints only), Phase 10.2.5 Developer Docs tab UI (base URL/auth guidance, endpoint cards from OpenAPI, and curl/node fetch samples), Phase 10.3.1 Marketplace Foundation (global app registry + per-org installs with encrypted config storage, one-time app secrets, install lifecycle APIs, enterprise gating, seed catalog, and Marketplace UI pages `/marketplace` + `/marketplace/[key]`), Phase 10.3.2 OAuth layer + UI integration (connect-first UX for OAuth apps, callback success/error handling, connected account badge with expiry/account details, and disconnect/reconnect controls on `/marketplace/[key]`), and Phase 10.3.3 Marketplace Runtime Hooks (encrypted app secret storage, app-install event trigger delivery via configured webhook URL, signed inbound `/api/v1/apps/commands` with idempotency + per-install rate limits + scope checks, and persistent AppCommandLog auditing). |

## Thumb Rule (Mandatory)

After **every step update** (feature, fix, migration, or hardening task), update this file immediately:

1. Add or update the relevant phase row.
2. Mark status as `Completed`, `In Progress`, or `Planned`.
3. Add a one-line summary of what changed in that step.
4. Keep this file in the same commit as the implementation whenever possible.

## Latest Step Update
- Date: 2026-02-17
- Step: Phase 6.4.19 Public Status Page + Uptime
- Status: Completed
- Highlights: Public status infrastructure added (status components + uptime checks), incident publishing flow with public summaries/updates/slugs, public status endpoints and pages (`/status`, `/status/incidents/[slug]`), periodic uptime-scan scheduler/worker integration, and internal incident publish/update controls in Developer Incidents tab.
