# AGENTS.md - Kritviya Build Rules (Phase-Based)

This repository is built in strict phases. Agents must follow the current phase scope and must not jump ahead.

## 0) Project Summary

Kritviya is a horizontal Execution OS:

- One unified system (no separate apps)
- Role-based MODES: CEO / Ops / Sales / Finance / Admin
- Everything is org-scoped and audit-ready

Tech:

- Frontend: Next.js (App Router) + TypeScript
- Backend: NestJS + TypeScript
- DB: Postgres (Docker Compose for local)
- Monorepo: npm workspaces
- Shared types/constants: `packages/shared`

## 1) Phase Rules (Hard Constraints)

### Phase 7: Stabilization + Security + UX Resilience (CURRENT)

Allowed:

- Stabilization and hardening of existing Phase 1-6 features
- API robustness: validation, sanitization, consistent error responses, pagination/sorting
- Security baseline upgrades (Sudarshan Shield v1): expanded throttling, secure headers, audit integrity
- Observability and production readiness improvements (structured logs, readiness checks, env hygiene)
- Frontend resilience: normalized API errors, loading/empty/error states, form validation, double-submit prevention
- Keep org scoping + RBAC strictly enforced server-side on all endpoints

Not allowed (DO NOT IMPLEMENT):

- New major business modules beyond existing scope
- Large redesigns or non-essential feature expansion
- Unrelated workflows outside stabilization/security/observability/UX resilience

Stop immediately if a requested change exceeds Phase 7 scope.

## 1.1) Phase Override (Owner Directive)

If the repository owner explicitly approves work from a different phase in their prompt, that directive overrides the current phase gate for that task.

When override is used:
- You may implement schema changes, endpoints, and UI required by the approved phase.
- You must keep Sudarshan Shield baseline intact.
- You must keep server-side RBAC and org scoping on every relevant query/mutation.
- You must include tests for new logic and avoid breaking existing flows.
- You must preserve backward compatibility unless the owner explicitly requests breaking changes.

## 2) Security Doctrine: Sudarshan Shield (Phase 2 baseline)

Implement and keep enforced:

- Password hashing with bcrypt
- JWT with expiry from env
- Strong DTO validation
- RBAC enforced server-side
- Org scoping enforced in DB queries (no in-memory filtering)
- Helmet headers
- Rate limiting on auth/login
- CORS restricted via env
- Request size limits
- Secrets via env only, `.env.example` kept current
- Production-safe error responses (no stack leaks)

## 3) Output Requirements for Agents

After changes:

1. Provide file tree summary
2. Provide exact commands to run
3. Confirm ports/endpoints
4. List Sudarshan Shield items implemented

## Phase Override (Owner Directive)
If the user explicitly approves a new phase (e.g., “Proceed with Phase 2”), the agent is authorized to implement new schema, endpoints, and UI required for that phase, while still:
- preserving security (RBAC/org scoping/audit logs)
- keeping tests/build passing
- avoiding breaking changes to existing routes unless unavoidable (then document + migrate)
