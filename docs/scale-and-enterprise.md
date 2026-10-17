# Analytics, custom workflows, API access, priority processing and SSO

Built in patch 0066. These were "Coming soon" on the pricing page; they are now listed as included.

| Feature | Plans | Where | Code |
| --- | --- | --- | --- |
| Analytics (7, 30, 90 days) | Free trial, Starter | Business → Analytics | `routers/analytics.py`, `services/analytics.py` |
| Advanced analytics (up to 365 days, funnel, sources, money owed by age, agents, channels, AI use, top customers) | Growth, Scale, Enterprise | Business → Analytics | same |
| Custom workflows | Scale, Enterprise | Business → Automations | `routers/custom_workflows.py`, `services/custom_workflows.py`, `workflows/custom.py` |
| API access | Scale, Enterprise | Organisation → API keys (`/developers`) | `routers/api_keys.py`, `services/api_keys.py`, `deps.current_user_id` |
| Priority processing | Scale, Enterprise | automatic | `engine/dispatch.py`, worker `PriorityWorkerSettings` |
| Single sign-on (OpenID Connect) | Enterprise | Organisation → Single sign-on (`/sso`) | `routers/sso.py`, `services/sso.py` |

Plan switches live in `kritvia_api/plans.py` (`Plan.analytics`, `Plan.extras`); `private.applied_plan` decides which plan applies (paid, then a running coupon, then Free). Database objects are in `migrations/0050_scale_features.sql`.

## Analytics

`GET /ventures/{v}/analytics?days=30` returns this period and the one before (money received and issued, leads, drafts, approvals), a daily, weekly or monthly trend, and for advanced plans the breakdowns. A basic plan asking for 180 or 365 days gets 402. The page draws two charts (recharts, series colours `--series-1`/`--series-2`, checked with the dataviz validator in light and dark) and exports CSV.

## Custom workflows

A workflow is *when* (invoice overdue / paid, booking done, new lead, quiet lead, plus a number of days), *what to write* (plain words, any language) and *then* (an email to the customer that waits for a yes, or a note to the maker by Telegram or email). The worker's minute cron calls `custom_workflows.fire_due`; each daily scan starts one run per matching record, at most 25 a day, and never the same record twice (trigger dedupe). Only the business's admins can make or change them; on a plan without them they can't be made, switched on or run.

## API keys

Owners make keys (`kvk_…`, shown once, stored as SHA-256). A key acts as its maker, only on its organisation, only on the allowlisted endpoints in `services/api_keys.py` (read: leads, invoices, bookings, proposals, approvals, automations, analytics, ventures; write keys also add/update leads, add invoices, payments and bookings), 120 requests a minute, and only while the plan includes API access and the maker is still an owner. Revoking is immediate. The base URL is `PUBLIC_API_URL`.

## Priority processing

Runs of organisations on a plan with `priority_processing` are queued on `arq:priority`, served by the `worker-priority` compose service (`WORKER_PRIORITY_MAX_JOBS`, default 4). The dispatcher uses that queue only while the priority worker's heartbeat (`kritvia:priority-worker:alive`, 90 s) is present; otherwise it falls back to the normal queue, so nothing waits on a missing worker. `deploy.sh` builds and starts it.

## Single sign-on

1. The owner registers Kritvia as a web app in the identity provider with redirect URL `PUBLIC_WEB_URL/api/oauth/sso/callback` and scopes `openid email profile`.
2. They save the domain, issuer URL, client ID and secret (secret wrapped with the master key, context `kritvia-sso|<org>`; the app role can't read the column). Kritvia fetches `/.well-known/openid-configuration` and checks its issuer.
3. They add the TXT record `_kritvia-sso.<domain>` = `kritvia-sso=<token>` and press *Check the record* (DNS-over-HTTPS via Cloudflare, then Google).
4. Sign-in: `POST /api/auth/sso/start {email}` (BFF) → `/auth/sso/start` with a cookie nonce → the provider (code flow, PKCE S256 with the verifier derived from the nonce, OIDC nonce = hash of the cookie nonce) → `/api/oauth/sso/callback` → `/auth/sso/complete`, which checks the state, exchanges the code, verifies the id_token against the provider's JWKS (issuer, audience, expiry, nonce; RS/PS/ES algorithms only), requires the email to be on the domain (and `hd` for Google Workspace), and signs in an existing account or someone with a pending invitation.
5. *Require single sign-on* can be switched on only after an owner has signed in through SSO since the last provider change. Then password, email code, Google sign-in and password reset are refused for that domain. If the plan stops including SSO, both SSO and the requirement stop, so nobody is locked out.

Domains are unique across organisations. Terms 4.6 (SSO) and 4.7 (API keys); Privacy section 2 and 4.
