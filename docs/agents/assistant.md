# Kritvia assistant ("Ask Kritvia") and connected apps

A person asks for anything in plain words (English, Hindi or Hinglish) on the **Assistant** page. The assistant
works out the steps, uses the business's tools one at a time, and replies. Code: `apps/api/kritvia_api/workflows/assistant.py`,
`services/mcp.py`, `routers/assistant.py`; web: `app/(app)/v/[ventureId]/assistant`.

## How a request runs

1. **think**: the model (tier `plan`, i.e. the paid planner when switched on, otherwise the free models) sees
   the request, the business brief, the tool list and every step so far. It either answers or picks one tool.
2. **Read tools** run straight away and their result goes back to *think*: `knowledge.search`,
   `leads.search`, and connected-app tools the app marks read-only.
3. **Write and send tools** become an approval on the board and in the Inbox. Nothing happens until a person
   approves, optionally after editing; *act* then runs exactly the approved payload. These are
   `gmail.send`, `whatsapp.send`, `calendar.create_event`, `crm.update_lead`, and connected-app tools that
   change something (`mcp.call`, which a person always reviews).
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

- **Transport:** Streamable HTTP (initialize, tools/list, tools/call). JSON and SSE answers are both
  accepted.
- **Address checks:** addresses must be https and resolve only to public addresses. Private, loopback,
  link-local, metadata and multicast addresses are refused. The check runs when the app is added and
  before every call, and redirects are not followed.
- **Tools:** up to 40 tools are kept per app, with names, descriptions and field names only. The assistant
  sees them as `app.<name>.<tool>`.
- **Tokens:** stored encrypted with the business's key (purpose `mcp.token`) and never returned.
