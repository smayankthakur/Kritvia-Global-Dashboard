# Kritviya Roadmap Status (update.md)

This file tracks implementation status for every requested phase/step.

## Mandatory Rule (Thumb Rule)
- After every implementation step, update this file in the same commit.
- Each step must have one status: `Completed`, `In Progress`, or `Planned`.
- Do not mark `Completed` unless code is implemented and verified (build/tests/checks as applicable).

---

## PHASE 1 — Core Foundation

| Step | Status |
|---|---|
| 1.1 Monorepo + Dev Foundation | Completed |
| 1.2 Auth + Security Baseline | Completed |

Details covered: Next.js web, NestJS API, Prisma/Postgres, shared package, Docker, env management, lint/format, JWT login, RBAC, org scoping, Helmet/CORS, activity logs.

## PHASE 2 — Core Execution OS (MVP)

| Step | Status |
|---|---|
| 2.1 Sales Engine | Completed |
| 2.2 Work Execution | Completed |
| 2.3 Invoices (Money Loop) | Completed |
| 2.4 CEO Visibility | Completed |

Details covered: companies/contacts/leads/deals, lead->deal conversion, sales UI, work items, transitions, deal->work root, ops UI, invoice lifecycle with locking, finance UI, KPIs, bottlenecks, nudges, hygiene inbox.

## PHASE 3 — Guardrails & Autopilot

| Step | Status |
|---|---|
| 3.1 Policy Engine | Completed |
| 3.2 Auto Hygiene Jobs | Completed |
| 3.3 Sudarshan Shield | Completed |

Details covered: policy model/settings APIs, lock behavior rules, autopilot jobs runner, security events, audit enforcement, locking discipline.

## PHASE 4 — Execution Score Engine

| Step | Status |
|---|---|
| 4.1 OrgHealthSnapshot | Completed |
| 4.2 Health Score API | Completed |
| 4.3 Why Score Dropped | Completed |

Details covered: score calc + snapshot storage + daily delta, `/ceo/health-score`, `/jobs/compute-health-score`, explain endpoint with root-cause drivers + deep links.

## PHASE 5 — Revenue Intelligence

| Step | Status |
|---|---|
| 5.1 Revenue Forecast Engine | Completed |
| 5.2 Cashflow Forecast Engine | Completed |
| 5.3 CEO Revenue Dashboard | Completed |

Details covered: velocity/forecast metrics, overdue/cashflow projections, CEO revenue UI.

## PHASE 6 — Multi-Org Scalability

| Step | Status |
|---|---|
| 6.1 Org Switcher | Completed |
| 6.2 Portfolio Mode | Completed |
| 6.3 Invitations + Membership Lifecycle | Completed |
| 6.4 Scale Hardening | Completed |

Notes: strict pagination guards, bounded list queries, role/org rate limiting, async job queue primitives, short TTL caching, structured logging normalization, and env feature flags are implemented.

## PHASE 7 — Billing + Packaging

| Step | Status |
|---|---|
| 7.1 Plans + Gating | Completed |
| 7.2 Usage Metering | Completed |
| 7.3 Razorpay Integration | Completed |
| 7.4 Retention Jobs | Completed |
| 7.5 API Tokens (Service Accounts) | Completed |

Details covered: feature-gated plans, org usage/caps, Razorpay checkout/webhooks, retention cleanup jobs, scoped API tokens with IP allowlist + rate limiting.

## PHASE 8 — Enterprise Controls

| Step | Status |
|---|---|
| 8.1 Org Policies | Completed |
| 8.2 Audit & Logs UI | Completed |
| 8.3 Scale Hardening v2 | Completed |

Notes: v2 hardening delivered with throttling/circuit-breaker patterns and reliability-focused server safeguards.

## PHASE 9 — AI Execution Intelligence Layer

| Step | Status |
|---|---|
| 9.1 Insight Engine | Completed |
| 9.2 AI Action Layer | Completed |
| 9.3 LLM Explainability Layer | Completed |

Details covered: AIInsight model/APIs/UI panel, AIAction model/APIs with approve/execute/undo + inbox UI, LLMReport model + CEO brief/report generation with grounding/caching.

## PHASE 10 — Developer Platform & Marketplace

| Step | Status |
|---|---|
| 10.1 Public API + Webhooks | Completed |
| 10.2 Developer Portal | Completed |
| 10.3.1 App Registry + Install Model | Completed |
| 10.3.2 OAuth Apps | Completed |
| 10.3.3 Runtime Hooks | Completed |

Details covered: `/api/v1` + token scope enforcement, webhook registry/retry/circuit-breaker, `/developer` tabs (tokens/webhooks/logs/docs/apps), app registry/install/config/rotate, OAuth connect flow, signed app commands, idempotency, AppCommandLog, app test console.

## PHASE 11 — White-Label / Reseller SaaS Mode

| Step | Status |
|---|---|
| 11.1 Parent Tenant Model | Planned |
| 11.2 Custom Domain Support | Planned |
| 11.3 Brand Customization | Planned |
| 11.4 Reseller Billing Layer | Planned |

## PHASE 12 — Enterprise Scale & Competitive Moat

| Step | Status |
|---|---|
| 12.1 SOC-ready logging | Planned |
| 12.2 Advanced RBAC (custom roles) | Planned |
| 12.3 SSO (SAML / OIDC) | Planned |
| 12.4 Data export & backups | Planned |
| 12.5 AI Copilot Mode (real-time suggestions) | Planned |

## Latest Completed Step Update
- Date: 2026-02-17
- Completed:
  - Phase 6.4.22 Private Status Page SSO (Magic Link + Domain Allowlist)
  - Added `/status-auth/request-link`, `/status-auth/verify`, `/status-auth/logout`
  - Added PRIVATE_SSO mode with allowed email domains + one-time status auth tokens
  - Added status session cookie (`kritviya_status_session`) signed with `STATUS_SESSION_SECRET`
  - Added org status login/callback UI (`/status/o/[orgSlug]/login`, `/status/o/[orgSlug]/login/callback`)
  - Preserved PRIVATE_TOKEN mode behavior and org-scoped status endpoints
