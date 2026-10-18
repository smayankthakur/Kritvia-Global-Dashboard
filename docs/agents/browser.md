# Browser agent

**Browser** (next to Automations). Give it a job on the web in plain words, with a page to start at or
not (then it searches the web):

- "Find the GST rate for printed paper cartons on the CBIC website"
- "Check Indigo's baggage allowance for Delhi to Mumbai"
- "On example.com, send a bulk order enquiry for 20 kg kaju katli for Sunday"

The **assistant** can look things up too (tool `web.browse`, at most 8 actions, read only): "what does
Sharma Sweets charge for kaju katli?" It can't send forms; it points to the Browser page.

## How it works

1. A fresh, locked-down browser on Kritvia's own server opens the start page (or a DuckDuckGo search).
2. The model sees the page as text plus numbered links, buttons and fields, and picks one action: open a page,
   click, type, choose an option, tick a box, press a key, scroll, go back. At most 15 actions a job.
3. It ends with an answer (with the pages it used), or with a **form to send**.
4. A form becomes an approval showing the page, every field and value, and the button. It can't be edited
   (reject it with a note instead). After a yes, the form is sent exactly as approved on a fresh page, and the
   job reports what the website said next. Approvals of forms are always reviewed by a person (no earned
   autonomy).

## What it never does

| | |
|---|---|
| Sign in, create accounts, solve CAPTCHAs | it stops and says what the person must do |
| Type passwords, card numbers, OTPs, PINs, Aadhaar, PAN, bank details | refused by the browser itself, not only by the model |
| Send anything without a yes | the browser refuses every request except GET/HEAD/OPTIONS while browsing |
| Buy or pay, download or upload files | not possible |
| Reach this server or a private network | only public addresses on ports 80/443; every name is checked once and connected to directly (no DNS rebinding); the cloud metadata address and internal Docker services are unreachable |
| Keep cookies or logins | a fresh incognito browser per job, closed when the job ends (3 min idle, 10 min in all) |
| Follow instructions on web pages | page text is outside data; the model is told so, and the model router's prompt-injection guard screens it |

Pages are fetched as `Chrome/... KritviaAgent/1.0`, so websites can see it's an agent.

## Plans, roles, cost

- Growth, Scale, Enterprise (and Internal). The Browser page says when the plan or the server set-up is missing.
- Anyone who can change things in the business gives jobs; people see the jobs they gave. Forms need an approver
  or admin.
- Runs are tickets under Operations on the board; their model use counts like any agent's.

## Pieces

- `services/browser/` — the browser service (Chromium + egress guard), its own container and network
  (see its README and the runbook).
- `apps/api/kritvia_api/services/browser_agent.py` — client and the browse loop; `workflows/browser.py`;
  `routers/browser.py` (`/ventures/{v}/browser`, `/browser/status`, `/browser/{run_id}`); tools `web.browse`
  (read) and `browser.submit` (send, approval required).
- Web: `app/(app)/v/[ventureId]/browser/page.tsx`; the approval card shows website forms.
