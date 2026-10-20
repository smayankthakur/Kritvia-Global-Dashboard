# App store (patch 0095)

One assistant, any app. A business's admins connect apps on **App store** (`/v/<business>/apps`); once
connected, every request to the assistant can use them, beside Kritvia's own pages and agents. Tools that only
read run straight away; anything that changes an app is a draft a person approves (always reviewed, whatever
trust the assistant has earned). Included in Growth and above (integration `mcp`).

## Four ways in

| Tab | What | How it connects |
|---|---|---|
| Popular | Remote MCP servers Kritvia checked (Notion, Linear, Stripe, Jira & Confluence, HubSpot, Asana, Zapier, Intercom, Cloudflare, Hugging Face, Apify, Exa, GitHub) | sign-in (OAuth) or a token |
| Search all | The official MCP Registry (`registry.modelcontextprotocol.io`, API v0.1), synced hourly by the worker (`sync_app_store`, :17) | addresses install directly; packages need Kritvia's review |
| From GitHub | Paste a public project link | SKILL.md files become Kritvia skills (read as words, no code runs); a hosted address installs; an MCP package published to npm/PyPI is sent to Kritvia's team |
| By address | Any MCP server (Streamable HTTP, https, public internet only) | sign-in, bearer token, the app's own header (e.g. `x-api-key`), basic (`key:secret`) or none |
| Web app (API) | Any web app with an OpenAPI/Swagger description (JSON or YAML) | its operations become tools (40 at most, reads first); token as above |

## Sign-in (OAuth), as the MCP authorization spec asks of a client

1. The app answers 401 with `WWW-Authenticate: Bearer resource_metadata=…`; Kritvia reads the Protected Resource
   Metadata, then the authorization server's metadata (its `issuer` must match exactly). No PKCE S256 → refused.
2. Client: Kritvia's Client ID Metadata Document (`client_id = https://app.sitelytc.com/api/k/public/mcp-client.json`)
   when the server supports it, else dynamic client registration (`application_type: web`).
3. The person signs in at the app (PKCE S256, `state`, `resource` = the app's canonical address). The web app binds
   the sign-in to the browser (nonce cookie) and the API to the person (`app_oauth_pending`, 15 minutes).
4. Callback `/api/oauth/mcp/callback` → `POST /apps/oauth/complete`: `iss` checked, code exchanged with the
   verifier, tools listed, tokens stored encrypted (venture key, purpose `mcp.oauth`).
5. Tokens refresh a minute before they expire; if a refresh fails the app shows **sign in again** (`needs_auth`).

## Hosted apps (packages) and the review

- A package MCP server (npm, PyPI, container image) runs only after Kritvia's team approves **that version**
  on **Apps to review** (`/staff/apps`, STAFF_EMAILS), with the internet sites it may reach. Registry refreshes
  never change an approved version or reopen a decision. Businesses can ask for a registry package to be reviewed.
- It runs in `services/mcp-runner`: one gVisor (`runsc`) container per installed app, read-only root, no
  capabilities, uid 65534, memory/CPU/pids caps, on the internal `kritvia_mcp-sandbox` network whose only way out
  is the runner's egress proxy — per-instance credentials, only the approved sites (plus its package registry),
  public addresses only, checked once per connection. Settings (API keys) pass through the docker command's
  environment, never its arguments. Idle instances stop after 15 minutes and start again on the next call.
- Switch on: install gVisor (`services/sandbox/README.md`), set `MCP_RUNNER_URL=http://mcp-runner:8300` and
  `MCP_RUNNER_TOKEN` (`openssl rand -hex 32`) in `.env`, then `docker compose --profile apps up -d --build mcp-runner api worker`.
  Without them, hosted apps say they're off; everything else works.

## Events in

**Events in** on an installed app gives a webhook address and a secret (shown once). The app posts JSON with
`Authorization: Bearer <secret>`; a short summary (`summary`/`text`/`message`/`title`/`event`) becomes an
`app.event` on the business's event stream, so skills can start right after it and "tell me when" alerts fire.
At most 500 an hour per app.

## API

See the module docstring of `apps/api/kritvia_api/routers/app_store.py`. Migration `0067_app_store.sql`.
