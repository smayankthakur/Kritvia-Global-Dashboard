# apps/web — Kritvia command center

The web dashboard for Kritvia, the AI Business OS. It runs on Next.js 15 (App Router), React 19, TypeScript `strict`
and Tailwind CSS v4. Every screen is wired to the FastAPI backend through types generated from its OpenAPI schema
(`@kritvia/shared-types`), so if the backend contract changes in a way the frontend doesn't handle, the build fails.

## Architecture

```
browser ──► Next.js (this app) ──► FastAPI (KRITVIA_API_URL)
             ├─ /api/auth/{login,register,logout}   BFF auth: sets httpOnly cookies, never returns tokens
             ├─ /api/k/<path>                       BFF proxy: adds Bearer token, refreshes, streams
             └─ pages (client components + TanStack Query)
```

### Auth (BFF, no tokens in the browser)

- `POST /api/auth/login|register` calls the API's `/auth/*` endpoints from the server. It then stores the token pair
  in two cookies:
  - `kv_at` holds the access token. It is `HttpOnly`, `SameSite=Lax`, `Secure` in production, and its `Max-Age`
    equals `expires_in`.
  - `kv_rt` holds the refresh token. It has the same flags and a 30-day lifetime.

  The response body is only `{ ok: true }`. `POST /api/auth/logout` revokes the refresh token and clears both cookies.
- `app/api/k/[...path]/route.ts` is a catch-all proxy to `KRITVIA_API_URL`. Its logic lives in `lib/bff/proxy.ts`,
  where it is unit-tested.
  - It adds `Authorization: Bearer <kv_at>`.
  - If the API answers 401, or the access cookie has already expired, it refreshes **once** with `kv_rt`, sets the
    rotated cookies and retries.
  - Concurrent refreshes of the same refresh token are coalesced in-process. This matters because the API treats a
    reused refresh token as theft and revokes the whole token family.
  - Request bodies, including multipart bodies with their original boundary, are read once so the retry can resend
    them.
  - Responses, including binary downloads, are streamed back with their headers. Upstream `Set-Cookie` headers are
    dropped.
  - `/public/*` (the client upload link) is forwarded without a token.
  - `auth/login|register|refresh|logout` are **not** reachable through the proxy, because they would hand tokens to
    page JavaScript.
- CSRF protection: every non-GET request to `/api/auth/*` and `/api/k/*` must carry an `Origin` whose host matches the
  host that served the app. Behind a tunnel, `X-Forwarded-Host` is used. Extra origins can be allowed with
  `KRITVIA_TRUSTED_ORIGINS`.
- `middleware.ts` handles two jobs:
  - It redirects to `/login?next=…` when neither session cookie is present. `/login`, `/register`, `/upload/*`,
    `/api/*` and static files are exempt.
  - It sets a per-request **nonce-based Content-Security-Policy** on pages: `script-src 'self' 'nonce-…'
    'strict-dynamic'`, `style-src 'self' 'unsafe-inline'`, `connect-src 'self'`, `media-src 'self' blob:`,
    `frame-ancestors 'none'`, `object-src 'none'`.
- `next.config.ts` sets the remaining headers:
  - on every response: `X-Frame-Options`, `nosniff`, `Referrer-Policy: no-referrer`, COOP/CORP, a
    `Permissions-Policy` that allows the microphone only for this origin, and HSTS in production;
  - on `/api/*`: a deny-all CSP.

### Data fetching

- `lib/api.ts` creates `createClient<paths>({ baseUrl: "/api/k" })` (openapi-fetch).
  - `unwrap()` turns each response into data or an `ApiError`. The `ApiError` carries `status`, the API's `detail`,
    field errors from 422 responses (keyed like `applicant.pan`) and `Retry-After`.
  - `multipart<Schema>()` builds typed `FormData` for upload endpoints.
- TanStack Query is used everywhere. A 401 anywhere redirects to `/login`. 404, 409, 422 and 429 are not retried.
- `components/ui/states.tsx` provides `QueryState`, which handles loading, error, empty and data for a query. It shows
  a 404 as "not found or you don't have access", because the API returns 404 on RLS denials.

### UI

- `components/ui/` is a small hand-built kit: Button, Field/Input/Textarea/Select/Checkbox/Switch, Badge, Card, Table,
  Tabs, Dialog/Sheet/ConfirmDialog (on the native `<dialog>`), Toast, EmptyState, Skeleton, Stat, CodeDiff, Markdown,
  FileDrop and CopyField.
- Design tokens are CSS variables in `app/globals.css`: slate neutrals with an indigo accent.
  - Light and dark mode follow `prefers-color-scheme`.
  - The theme toggle stores its choice in the `kv_theme` cookie, which the root layout reads on the server, so there
    is no flash when the page loads.
- Money is formatted as INR with Indian grouping (`₹2,95,000.00`). Dates are shown in IST (`lib/format.ts`).
- The layout is responsive down to 375px. Below `lg`, the sidebar becomes a sheet.

### Screens

| Route | What |
|---|---|
| `/login`, `/register` | Auth (password ≥ 12 chars) |
| `/onboarding` | Organisation → ventures (Sitelytc/Truhome/Cloud Kitchen presets) → your roles + workflow configs |
| `/` | Executive dashboard: totals, a card per venture, recent failures with Retry |
| `/inbox` | Approval inbox. Email and calendar payloads are rendered readably. Edit → client-side diff → approve with edits, or reject with feedback |
| `/v/[id]/runs`, `/runs/[runId]` | Runs with status filter, and a run timeline that polls every 3 s while a run is queued or running. Retry and cancel |
| `/v/[id]/leads`, `/proposals`, `/proposals/[pid]`, `/rate-card` | Sitelytc: leads with score breakdown, new inquiry form, cited proposals, rate-card editor |
| `/v/[id]/loans`, `/loans/[appId]`, `/checklists` | Truhome: applications with a consent step, document upload and verification, checklist result, client upload link, checklist editor |
| `/v/[id]/kitchen/plan`, `/reference`, `/sales`, `/events` | Kitchen: daily plan (forecast, prep list, POs), MAPE, reference data and CSV import/templates, sales chart, stock count, events |
| `/v/[id]/knowledge`, `/knowledge/[doc]` | Cited Q&A, documents (upload, note, restricted roles), entities, chunk-level citations |
| `/v/[id]/meetings`, `/tasks` | Upload or record in the browser; tasks and decisions linked back to their timestamps |
| `/v/[id]/trust` | Earned autonomy per agent and action |
| `/v/[id]/compliance` | Consents, DPDP requests (export/erasure), retention, breach register |
| `/v/[id]/settings` | Venture settings, workflow configs, Google and webhook connectors, members and grants, model tiers and usage |
| `/settings/connectors` | Google OAuth callback target: shows a toast, then redirects to that venture's settings |
| `/audit` | Hash-chained audit log with "Verify chain" (owners) |
| `/upload/[token]` | Public client upload page (no login) |

The global **Ask** (⌘K) searches across all ventures. The **mic** button records a short note, transcribes it with
`/ventures/{id}/transcribe` and inserts the text into the field that last had focus.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `KRITVIA_API_URL` | `http://localhost:8000` | FastAPI base URL, used server-side only |
| `NEXT_PUBLIC_APP_NAME` | `Kritvia` | Optional brand name |
| `KRITVIA_COOKIE_SECURE` | `true` in production | Set to `false` only for plain-HTTP LAN testing |
| `KRITVIA_TRUSTED_ORIGINS` | – | Comma-separated extra origins accepted by the CSRF check |

The API must list the web origin in `ALLOWED_ORIGINS`. It must also have `PUBLIC_WEB_URL` set to this app's URL: upload
links and the Google OAuth callback redirect there.

## Scripts

```bash
pnpm install                         # at the monorepo root
pnpm --filter @kritvia/web dev       # http://localhost:3000
pnpm --filter @kritvia/web build     # production build (standalone output)
pnpm --filter @kritvia/web start     # next start
pnpm --filter @kritvia/web lint      # eslint (next/core-web-vitals + next/typescript), zero warnings
pnpm --filter @kritvia/web typecheck # tsc --noEmit
pnpm --filter @kritvia/web test      # Vitest + Testing Library
pnpm --filter @kritvia/web e2e       # Playwright smoke against a real API
```

### Tests

- **Unit tests** (`tests/`) cover:
  - INR and IST formatting;
  - the payload diff logic;
  - the BFF proxy: refresh and retry, proactive refresh, refresh coalescing, multipart resend, binary passthrough,
    blocked auth paths, 502;
  - the Origin (CSRF) check;
  - the auth route handlers;
  - the approval detail component: edit → diff preview → submitted payload shape, calendar times in IST, reject
    feedback, missing role, 409.
- **E2E** (`e2e/smoke.spec.ts`) runs one serial flow:
  1. register, then onboard 3 ventures;
  2. save the rate card;
  3. submit an inquiry, which starts a run that fails without an LLM, and check that Retry is visible;
  4. create a loan application with consent, create a client upload link, open the public page and the expired
     state;
  5. upload a document and add a note;
  6. import kitchen CSVs, upload sales CSV, count stock, add an event and run the daily plan (this needs no LLM);
  7. edit and approve the real PO draft in the inbox (with diff);
  8. record and withdraw a consent, then export a DPDP access request;
  9. create a webhook;
  10. use mobile navigation;
  11. verify the audit chain.

  It saves desktop and 375px screenshots to `e2e/screenshots/`.

To run the e2e test locally, start Postgres and the API as described in the root README. Then:

```bash
pnpm --filter @kritvia/web build
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers pnpm --filter @kritvia/web e2e   # starts `next start` itself
```

## Deployment

- **Vercel Hobby is non-commercial.** Use it only for internal dogfooding. The BFF must reach the API, so the API has
  to be publicly reachable, for example through the tunnel.
- **Client pilots:** self-host on the same VM behind the same Cloudflare Tunnel as the API. Put the web app and the API
  on one hostname or on sibling hostnames, and point `KRITVIA_API_URL` at the API's internal address.
- **Docker:** `next.config.ts` uses `output: "standalone"`. Build from the monorepo root:

  ```bash
  docker build -f apps/web/Dockerfile -t kritvia-web .
  docker run -p 3000:3000 -e KRITVIA_API_URL=http://api:8000 kritvia-web
  ```

  The image is multi-stage (pnpm, frozen lockfile), runs as a non-root user and starts with
  `node apps/web/server.js`.
- **Refresh coalescing is per process.** If you run several web replicas, use sticky sessions or a single instance.
  Otherwise a refresh race between replicas can trip the API's refresh-token reuse detection and sign the user out.
- The API trusts `CF-Connecting-IP` for rate limiting. The proxy forwards it, so each client keeps its own rate-limit
  bucket.
