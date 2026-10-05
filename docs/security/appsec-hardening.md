# Kritvia — Phase 2: application security and server hardening

Last reviewed: 6 October 2026. Each control lists where it lives and the test that keeps it true.
Kritvia signs people in with an emailed code or Google; passwords are optional and only used if a
person sets one, so the password controls below apply to that path.

## Architecture in one paragraph

Browser → Cloudflare (TLS, tunnel; no open inbound ports on the server) → Next.js web app (pages and the
backend-for-frontend, "BFF", at `/api/*`) → FastAPI API on the private Docker network → PostgreSQL with
row-level security. The browser never holds a token: sessions are httpOnly cookies that only the BFF reads,
and it adds `Authorization: Bearer` when it calls the API. Postgres, Valkey and the API listen on
127.0.0.1 / the internal network only.

## Headers and networking

| Control | Where | Status |
| --- | --- | --- |
| HSTS `max-age=63072000; includeSubDomains` | `apps/web/next.config.ts` (production), API middleware | Done. Add `preload` only after submitting the domain at hstspreload.org — it is hard to undo |
| Content-Security-Policy with per-request nonce, no outside origins, `frame-ancestors 'none'` | `apps/web/lib/csp.ts`, `middleware.ts` | Done; `trust-scan` fails if an outside origin is added |
| `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, COOP/CORP same-origin, `Permissions-Policy`, `X-Permitted-Cross-Domain-Policies: none`, `X-DNS-Prefetch-Control: off`, no `X-Powered-By` | `next.config.ts` | Done |
| API responses: CSP `default-src 'none'`, `Cache-Control: no-store`, nosniff, no `Server` header | API middleware; `uvicorn --no-server-header` | Done |
| CORS locked down | API `main.py`: production ignores any origin that isn't an exact `https://` origin (no `*`); methods and headers listed; the browser never calls the API directly | Done — `test_production_hides_schema_and_password_signup` |
| No directory listing | Next.js serves only built pages and files in `public/`; there is no static file server with auto-index; source maps are not published | Done |
| No default admin routes | API explorer (`/docs`), ReDoc and `/openapi.json` are off in production; there is no admin web panel — operators use the database over EC2 Instance Connect | Done — test above |
| Only the web app is public | Ports bound to 127.0.0.1; Cloudflare Tunnel is the only way in | Done (`infra/docker-compose.yml`) |

## Authentication and sessions

| Control | Where | Status |
| --- | --- | --- |
| CSRF: Origin check **and** double-submit token | `lib/bff/origin.ts`, `lib/bff/csrf.ts`; middleware hands out `__Host-kv_csrf`; the API client sends `X-KV-CSRF` on every change; the BFF refuses a mismatch (403) | Done — `tests/proxy.test.ts`, `tests/auth-bff.test.ts` |
| Cookie flags | `kv_at`/`kv_rt`: `HttpOnly; Secure; SameSite=Lax; Path=/`. `SameSite=Lax` (not Strict) is required so the session survives the redirect back from Google sign-in; Origin + CSRF token cover the gap | Done |
| Sessions reset on password change or reset | Refresh-token families revoked; access tokens issued before `password_changed_at` rejected | Done — `test_old_access_tokens_die_on_password_change`, `test_forgot_password_resets_and_signs_other_sessions_out` |
| Reset and sign-in codes expire within 15 minutes | 10 minutes by default; settings refuse more than 15; single use; burnt after 5 wrong tries | Done — `test_codes_cannot_be_configured_to_last_longer_than_15_minutes` |
| Refresh-token theft detection | Reusing a rotated refresh token revokes the whole family | Done |

## Attack prevention

| Control | Where | Status |
| --- | --- | --- |
| Rate limits | Per IP and per email on every auth endpoint; 3 codes/min and 20/day per address; 30 code checks/day; 30 password tries/hour; public forms 3/min | Done (`ratelimit.py`, Valkey in production) |
| Progressive lock-out | 5 consecutive failures for an address (password, code, reset, or current password when changing it) → paused 1, 2, 4 … 60 minutes; success clears it; the owner gets an email the first time | Done — `test_failed_sign_ins_lock_progressively_and_identically_for_unknown_addresses` |
| No user enumeration | Same answers for known and unknown addresses: code requests always "sent"; login always "invalid credentials"; lock-outs apply to unknown addresses too; the password sign-up endpoint (which would say "already registered") is off in production | Done |

## Input and storage

| Control | Where | Status |
| --- | --- | --- |
| Request size limits | `bodylimit.py` refuses oversized bodies before parsing (auth 64 KB, public forms 1 MB / 64 KB, uploads 60 MB) | Done |
| Upload allowlist with magic-number checks | `services/uploads.py`: extension must be on the list for that upload AND the first bytes must match (PDF, DOCX, images, audio, text); the stored MIME type is ours, never the browser's; downloads are `attachment` + nosniff | Done — `test_uploads_must_really_be_the_type_they_claim`, `test_upload_endpoint_refuses_disguised_files` |
| SQL injection | Every query uses bound parameters (`text(...)` with `:name`); the few dynamic SQL fragments are fixed column lists, never user input | By design; review rule below |
| XSS | React escapes all output; Markdown is rendered without raw HTML; the only `dangerouslySetInnerHTML` is JSON-LD with `<` escaped; strict CSP blocks injected scripts | Done |
| Bad text | NUL bytes and invalid encodings are refused with 422, never stored or turned into a 500 | Done — `test_text_with_nul_bytes_is_refused_not_a_500` |
| Least-privilege database role | The app connects as `kritvia_app`: not superuser, no BYPASSRLS, cannot create roles, databases or tables, owns nothing; migrations run as `kritvia_owner`; every table with tenant data has row-level security enabled **and forced** | Done — `test_app_database_role_has_least_privilege` |

**Why we don't "sanitise" text before storing it.** Escaping or stripping HTML on the way in corrupts
legitimate data (a customer named `O'Brien & <Sons>`) and gives a false sense of safety, because the
same data later flows into emails, PDFs and AI prompts that need different encodings. The OWASP rule is:
validate on input (types, lengths, allowlists — done with Pydantic models on every endpoint), use
parameterised queries, and encode on output for the place it is shown. That is what Kritvia does.

**Review rule for new code:** no f-string or `+` builds SQL from request data; no `dangerouslySetInnerHTML`
with anything but escaped JSON; every new upload endpoint calls `read_checked(file, kind)`.

## Server and edge settings (owner checklist)

These live outside the code; set them once and re-check quarterly.

**Cloudflare (sitelytc.com zone)**
- SSL/TLS mode **Full (strict)**; Minimum TLS 1.2; Always Use HTTPS on; TLS 1.3 on.
- WAF managed rules on; a rate-limiting rule for `/api/auth/*` (e.g. 20 requests per minute per IP) as
  a second line in front of the app's own limits.
- Bot Fight Mode on for `app.sitelytc.com` (check Google sign-in still works afterwards).
- Tunnel public hostnames: only `app.sitelytc.com → http://web:3000`. If webhooks need the API, expose
  only `/hooks/*` and `/public/billing/*` paths, never the whole API.

**EC2**
- Security group: no inbound rules except what EC2 Instance Connect needs (or none, if you use Session
  Manager). The tunnel is outbound-only.
- `unattended-upgrades` on; reboot when "System restart required" shows (it did on 5 Oct).
- Docker socket only reachable by the sandbox service (already so); keep `/opt/kritvia/.env` mode 600.
- Backups: the nightly encrypted backup and restore test already run (see `docs/runbook.md`).

## Known follow-ups

- Rename session cookies to `__Host-kv_at` / `__Host-kv_rt` (signs everyone out once; schedule it).
- Add `preload` to HSTS after deciding to submit the domain.
- Consider WebAuthn / passkeys as a sign-in option (Phase 3+).
