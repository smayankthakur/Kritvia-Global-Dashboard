# Kritvia assistant ("Ask Kritvia") and connected apps

A person asks for anything in plain words (English, Hindi or Hinglish) on the **Assistant** page. The assistant
works out the steps, uses the business's tools one at a time, and replies. Code: `apps/api/kritvia_api/workflows/assistant.py`,
`services/mcp.py`, `routers/assistant.py`; web: `app/(app)/v/[ventureId]/assistant`.

## How a request runs

1. **think**: the model (tier `plan`, i.e. the paid planner when switched on, otherwise the free models) sees
   the request, the business brief, the tool list and every step so far. It either answers or picks one tool.
2. **Read tools** run straight away and their result goes back to *think*:
   - `knowledge.search` (documents and notes), `leads.search`, `invoices.search`, `shipments.search`;
   - `business.numbers`: money received, invoices issued, still to collect and overdue, bookings, new and
     won leads and drafts for a period (the same numbers automations report, from `services/automations.py`);
   - `tasks.search`: cards on the task boards, by words, person or open/done;
   - `approvals.waiting`: what waits for a yes (titles only; sensitive drafts are left out);
   - `indiamart.enquiries`, `whatsapp.templates`;
   - connected-app tools the app marks read-only.
3. **Write and send tools** become an approval on the board and in the Inbox. Nothing happens until a person
   approves, optionally after editing; *act* then runs exactly the approved payload. These are
   `gmail.send`, `whatsapp.send`, `whatsapp.template`, `calendar.create_event`, `crm.update_lead`,
   `tasks.create` (a card on the default board; the person is matched by name or email among the business's
   people, and left unassigned if the name matches no one or several), `leads.create` (source
   `assistant`), and connected-app tools that change something (`mcp.call`, which a person always reviews).
4. A draft that isn't approved goes back to the model with the person's comment. After 3 refusals the
   assistant stops.

## Limits and guardrails

- **Tool steps:** at most 8 per request, after which the assistant must answer.
- **Bad tool calls:** an unknown tool, missing fields or a failed lookup is reported back to the model, not
  retried blindly. Sandbox (code) tools are never offered.
- **Outside text:** tool results are treated as outside data. The router's prompt-injection guard screens
  them, and the prompt forbids following instructions inside them.
- **Privacy:** a person sees only their own requests. The run title is generic, the run summary holds counts
  only, and the request, steps and answer stay in the encrypted run state.
- **Plans:** the assistant is a core agent, so it is on every plan including the trial. Earned autonomy
  works as for other agents (agent `assistant`).

## Connected apps (MCP)

Admins add an app's MCP server address and, if needed, a token, on the Assistant page. Connected apps come
with Growth and above (integration `mcp`).

**Quick picks** fill the form:
- **Zapier (8,000+ apps):** address `https://mcp.zapier.com/api/v1/connect`. In Zapier MCP the owner adds a
  server for "Other", picks the apps and actions, and generates a connection token on the Connect tab
  (shown once). Kritvia sends it as `Authorization: Bearer …`, the form Zapier recommends over a token in
  the address. Each business uses its own Zapier account and token (docs.zapier.com/mcp).
- **Another app's MCP server:** any https address on the public internet.

- **Transport:** Streamable HTTP (initialize, tools/list, tools/call). JSON and SSE answers are both
  accepted.
- **Address checks:** addresses must be https and resolve only to public addresses. Private, loopback,
  link-local, metadata and multicast addresses are refused. The check runs when the app is added and
  before every call, and redirects are not followed.
- **Tools:** up to 40 tools are kept per app, with names, descriptions and field names only. The assistant
  sees them as `app.<name>.<tool>`.
- **Tokens:** stored encrypted with the business's key (purpose `mcp.token`) and never returned.

## One assistant for everything (patch 0093)

One prompt can now reach every page and agent of the business. It works from the Assistant page, from
**Do it** in the Ask dialog (⌘K), from WhatsApp, from Telegram and by voice. The assistant uses three more
tools (`services/actions.py`).

### The three tools

- **`kritvia.find`** (read) searches a catalogue of the app's own actions. The catalogue is built from the
  API's OpenAPI description, so new pages appear in it by themselves. Each result gives the action's exact
  name and its fields, for example `POST /ventures/{venture_id}/invoices`. Agents are found by their names,
  for example "switch on the payment reminders agent".
- **`kritvia.read`** runs a GET action straight away.
- **`kritvia.do`** is for any action that changes something. It becomes an approval card showing the exact
  call, and a person always reviews it: earned trust never sends it by itself. Only the body can be edited
  on the card. After the yes, it runs **as the person who approved it**, through the app itself (in-process,
  with a one-minute token). The same role checks and row-level security apply, so nobody can do through the
  assistant what they couldn't do on the page.

### What is never reachable

- Other businesses: only `/ventures/{this business}/…` is in the catalogue.
- Approvals, trust and autonomy: the assistant can't approve its own drafts or give itself more freedom.
- Members and invites, privacy requests, connected apps, API keys, billing, SSO, and the assistant itself.
- Changes to connectors and their secrets.
- File uploads, and deleting the business.

### Requests with several parts

The planner keeps a short `plan`, the parts still to do, and works through them one tool at a time. It has
up to 20 tool steps per request (it was 8). For example: "make the invoice, switch on payment reminders and
send me the cash every Monday". Things the person wants done regularly become routines (`routines.create`).
