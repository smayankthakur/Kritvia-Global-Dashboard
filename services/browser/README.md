# services/browser — a locked-down browser for the browser agent

```
app.py        HTTP service: sessions (read-only), approved one-shot submits, health
guard.py      URL checks + EgressProxy (every connection Chromium makes goes through it)
snapshot.js   numbers links, buttons and fields on a page; never returns sensitive values
tests/        against a local test site (needs Playwright's Chromium)
```

What keeps it safe (see app.py and guard.py):

1. **One job at a time**, fresh incognito context per job: no cookies, logins or storage carried over;
   no downloads, service workers or permissions; images, media and fonts not loaded; sessions end
   after 3 minutes idle, 10 minutes in all, or 40 actions.
2. **Read-only by default.** Chromium's own requests other than GET/HEAD/OPTIONS are refused, so a click
   can't send a form, place an order or post anything. A form is sent only through `POST /submit`,
   which the API calls after a person approved exactly that form (URL, fields, button).
3. **Never** fills password, card, OTP, PIN, Aadhaar/PAN or bank-account fields, or uploads files.
   It doesn't sign in or solve CAPTCHAs; the agent stops and says so.
4. **Network guard:** public addresses on ports 80/443 only. Every name is resolved once and must
   resolve only to public addresses; the proxy connects to the address it checked (no DNS rebinding).
   Loopback, private ranges, link-local (the cloud metadata address), CGNAT, multicast and reserved
   ranges are refused, also for requests a page makes itself. 150 MB of traffic per session.
5. **Container** (compose): non-root user, read-only root with a small tmpfs, all capabilities dropped,
   no-new-privileges, memory/CPU/pids limits, its own network (no database, cache or model gateway on it),
   bearer token, reachable only from the API and workers. Set `BROWSER_RUNTIME=runsc` once gVisor is
   installed (`docker info | grep -i runsc`) to put a user-space kernel under Chromium too.

Tests: `PLAYWRIGHT_BROWSERS_PATH=... python -m pytest services/browser/tests` (pip install -r
requirements.txt pytest pytest-asyncio httpx; `playwright install chromium`).

## Production layout (test report round 2: S5, S10)

Three containers from this image (infra/docker-compose.yml, profile `browser`, started by deploy.sh only when
`.env` has `BROWSER_TOKEN` and `BROWSER_RUNTIME=runsc`):

- `browser-chromium`: Chromium under gVisor on the internal `browser-internal` network, with no route anywhere.
  Each session's proxy checks names by their text and tunnels every connection to `browser-egress`
  (`BROWSER_EGRESS`, token `BROWSER_EGRESS_TOKEN` = `BROWSER_TOKEN`). Chromium's own sandbox is on; under gVisor
  it falls back to gVisor's isolation only if the sandbox can't start there.
- `browser-egress` (`python guard.py egress 8401`): the only way out. CONNECT only, with the token, to public
  addresses it resolves and checks itself, connecting to the checked address.
- `browser` (`python guard.py relay 8200 browser-chromium 8200`): the door from the stack's network, so
  `BROWSER_URL=http://browser:8200` is unchanged and the API, workers, database and cache are never on
  Chromium's network.

An approved submit carries the form's fingerprint (action, method, hidden-field names, recorded when the card
was made); if the page's form differs, nothing is sent. While the approved values are typed in, the page may
reach only its own site and the form's target, script requests and WebSockets elsewhere are refused, and one
form navigation may send data.
