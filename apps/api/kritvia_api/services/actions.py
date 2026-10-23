"""Everything Kritvia's own app can do, for the assistant: one prompt can reach every page.

The assistant used to know only a fixed list of tools. Now it can also find and use any of the business's own
API actions (the same ones the web app calls): make an invoice, add a supplier bill, start or set up any agent,
open a role, mark attendance, create a campaign, change booking hours, read the cash forecast…

  find   kritvia.find (read)   searches the catalogue (built from the API's own description) for the actions
                               that match the words, with their fields
  read   kritvia.read (read)   runs a GET action straight away and returns its answer
  do     kritvia.do (write)    any other action becomes an approval card showing the exact call; when a person
                               approves it (they may edit the body), it runs *as that person*, so nobody can do
                               through the assistant what they couldn't do on the page

The call goes through the app itself (in-process, same checks, same row-level security), with a token that
lives one minute. What it may reach is an ALLOW-list (test report round 2, S3):
  - reads: any GET of this business (only /ventures/{this business}/…), except the few that hold link codes,
    keys or the assistant's own controls (DENY)
  - changes: only the business's ordinary records (WRITE_AREAS: leads, tasks and boards, invoices and bills,
    bookings, notes, proposals, campaigns as drafts, staff and attendance, shipments, kitchen records,
    routines…), minus the parts of those areas that reach outside or change who is paid (WRITE_EXCEPT)
  - never: approvals, trust and autonomy, agent settings (workflow-configs), members and invites, approver
    links, payment settings, phone and speech credentials, connectors, connected apps, API keys, billing, SSO,
    retention and privacy (DPDP) requests, the assistant itself, file uploads, deleting the business
Write actions are always reviewed by a person (never sent by earned trust).
"""
from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx

PREFIX = "/ventures/{venture_id}"
# Never reached, not even to read: the assistant's own controls, and anything that returns a link code or a key.
DENY = ("/approvals", "/trust", "/members", "/invites", "/privacy", "/apps", "/assistant", "/api-keys",
        "/billing", "/sso", "/audit/export", "/erase", "/connectors/email-forwarding", "/approver-links",
        "/voice/keys", "/dpdp-requests", "/retention", "/connectors/google/picker")
# The only areas (first path part after /ventures/{venture_id}) where the assistant may change something.
WRITE_AREAS = frozenset({
    "ads", "ask", "attendance", "automations", "bank", "bills", "booking-services", "bookings", "boards", "cards",
    "lists", "campaigns", "candidates", "cash", "custom-workflows", "event-alerts", "facts", "invoices", "jobs",
    "kitchen", "leads", "loan-applications", "meetings", "notes", "proposals", "rate-card", "review-replies", "runs",
    "shipments", "skills", "social", "staff", "tickets", "vocabulary", "whatsapp",
})
# Inside those areas: what reaches outside the app or can't be undone stays on its page.
WRITE_EXCEPT = (
    "/campaigns/{campaign_id}/send",            # one yes sends to a whole list: decided on the Campaigns page
    "/review-replies/{reply_id}/post",          # publishes on Google
    "/whatsapp/templates",                      # submits to Meta
    "/kitchen/import", "/vocabulary/import",    # bulk imports
    "/bank/statements",                         # a person's statement file
)
# Agents the assistant doesn't start through kritvia.do: itself, and the ones that reach outside on their own.
NOT_STARTED_HERE = frozenset({"assistant", "browser", "prospector"})
MAX_RESULT = 6000
METHODS = ("get", "post", "put", "patch", "delete")
transport_override: httpx.AsyncBaseTransport | None = None      # tests may inject


class ActionError(Exception):
    pass


@dataclass
class Action:
    id: str                      # "POST /ventures/{venture_id}/invoices"
    method: str
    path: str
    summary: str
    tags: list[str]
    path_params: list[str]
    query: dict[str, str] = field(default_factory=dict)
    body: dict[str, str] = field(default_factory=dict)
    words: str = ""

    def as_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"action": self.id, "what": self.summary}
        extra = [p for p in self.path_params if p != "venture_id"]
        if extra:
            out["path"] = {p: _agent_keys() if p == "workflow" else "id (from an earlier lookup)" for p in extra}
        if self.query:
            out["query"] = self.query
        if self.body:
            out["body"] = self.body
        if self.id == "POST /ventures/{venture_id}/runs":
            out["body"] = {**self.body, "workflow": _agent_keys()}
        return out


def _schema_words(schema: dict, comps: dict, depth: int = 0) -> str:
    """'string (required)'-style description of a field's schema."""
    if "$ref" in schema:
        name = schema["$ref"].rsplit("/", 1)[-1]
        target = comps.get(name, {})
        if "enum" in target:
            return "one of " + ", ".join(map(str, target["enum"][:12]))
        if depth < 1 and target.get("properties"):
            inner = ", ".join(list(target["properties"])[:10])
            return f"object with {inner}"
        return name
    if "anyOf" in schema:
        parts = [_schema_words(s, comps, depth) for s in schema["anyOf"] if s.get("type") != "null"]
        return " or ".join(p for p in parts if p) or "value"
    if "enum" in schema:
        return "one of " + ", ".join(map(str, schema["enum"][:12]))
    t = schema.get("type", "value")
    if t == "array":
        return f"list of {_schema_words(schema.get('items', {}), comps, depth + 1)}"
    fmt = schema.get("format")
    return f"{t} ({fmt})" if fmt else t


def _body_fields(op: dict, comps: dict) -> tuple[dict[str, str], bool]:
    """The JSON body's fields in words, and whether the action takes a JSON body at all (False for uploads)."""
    rb = op.get("requestBody")
    if not rb:
        return {}, True
    content = rb.get("content", {})
    if "application/json" not in content:
        return {}, False
    schema = content["application/json"].get("schema", {})
    if "$ref" in schema:
        schema = comps.get(schema["$ref"].rsplit("/", 1)[-1], {})
    props, req = schema.get("properties", {}), set(schema.get("required", []))
    out = {}
    for k, v in list(props.items())[:40]:
        desc = (v.get("description") or "")[:120]
        out[k] = f"{_schema_words(v, comps)}{' (required)' if k in req else ''}{' — ' + desc if desc else ''}"
    return out, True


def allowed(method: str, path: str) -> bool:
    """Whether the assistant may use this API action at all (reads broadly, changes only by allow-list)."""
    if not (path == PREFIX or path.startswith(PREFIX + "/")):
        return False
    if any(d in path for d in DENY):
        return False
    if method == "get":
        return True
    area = path[len(PREFIX):].split("/")[1] if path != PREFIX else ""
    if area not in WRITE_AREAS:
        return False
    return not any(x in path for x in WRITE_EXCEPT)


_catalogue: list[Action] | None = None


def catalogue() -> list[Action]:
    """Built once per process from the API's own OpenAPI description."""
    global _catalogue
    if _catalogue is not None:
        return _catalogue
    from kritvia_api.main import app
    spec = app.openapi()
    comps = spec.get("components", {}).get("schemas", {})
    out: list[Action] = []
    for path, ops in spec.get("paths", {}).items():
        for method in METHODS:
            op = ops.get(method)
            if not op or not allowed(method, path):
                continue
            body, json_ok = _body_fields(op, comps)
            if not json_ok:
                continue
            summary = (op.get("summary") or "").strip()
            doc = (op.get("description") or "").strip().split("\n")[0][:200]
            params = op.get("parameters", [])
            q = {p["name"]: _schema_words(p.get("schema", {}), comps) + (" (required)" if p.get("required") else "")
                 for p in params if p.get("in") == "query"}
            a = Action(id=f"{method.upper()} {path}", method=method.upper(), path=path,
                       summary=f"{summary}. {doc}".strip(". ") if doc and doc != summary else summary,
                       tags=list(op.get("tags", [])), path_params=re.findall(r"{(\w+)}", path), query=q, body=body)
            a.words = " ".join([a.summary, " ".join(a.tags), re.sub(r"[{}_/-]+", " ", path), " ".join(body),
                                {"GET": "list show get read see", "POST": "add create new start make send run",
                                 "PUT": "set change update save", "PATCH": "change update edit",
                                 "DELETE": "remove delete cancel"}[a.method]]).lower()
            if "workflow" in path or path.endswith("/runs"):
                a.words += " agent agents " + _agent_words()
            out.append(a)
    _catalogue = out
    return out


def _agent_words() -> str:
    """Every agent's key and title, so 'run the social posts agent' finds the run and settings actions."""
    from kritvia_api.engine.core import registry
    words = []
    for w in registry.all():
        words += [w.name.replace("_", " "), w.title]
    return (" run start now switch on off enable disable schedule time settings " + " ".join(words)).lower()


def _agent_keys() -> str:
    from kritvia_api.engine.core import registry
    return "the agent's key: " + ", ".join(f"{w.name} ({w.title})" for w in registry.all() if w.name != "assistant")


def _agent_names() -> set[str]:
    from kritvia_api.engine.core import registry
    out: set[str] = set()
    for w in registry.all():
        out |= set(re.findall(r"[a-z]+", f"{w.name} {w.title}".lower())) - _STOP - {"by", "your"}
    return out


def areas() -> list[str]:
    """The areas the assistant can work in (the API's tags), for its prompt."""
    return sorted({t for a in catalogue() for t in a.tags})


_STOP = {"a", "an", "the", "to", "for", "of", "and", "or", "my", "me", "in", "on", "with", "please", "kar", "do",
         "ko", "ka", "ki", "ke", "hai", "se"}


def find(query: str, limit: int = 8) -> list[dict[str, Any]]:
    words = [w for w in re.findall(r"[a-z0-9]+", query.lower()) if w not in _STOP]
    if not words:
        return []
    agentish = "agent" in words or any(w in _agent_names() for w in words)
    scored = []
    for a in catalogue():
        s = sum(2 if re.search(rf"\b{re.escape(w)}", a.summary.lower()) else 1
                for w in words if w in a.words or w.rstrip("s") in a.words)
        if s and agentish and (a.id in ("POST /ventures/{venture_id}/runs",
                                         "PUT /ventures/{venture_id}/workflow-configs/{workflow}",
                                         "GET /ventures/{venture_id}/workflow-configs")):
            s += 4          # "run the social agent", "switch on payment reminders"
        if s:
            scored.append((s, -len(a.path), a))
    scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
    return [a.as_dict() for _, _, a in scored[:limit]]


def resolve(action: str) -> Action:
    action = re.sub(r"\s+", " ", (action or "").strip())
    for a in catalogue():
        if a.id.lower() == action.lower():
            return a
    raise ActionError(f"no action {action!r}: use kritvia.find to look it up, then give its exact 'action'")


_SAFE_SEG = re.compile(r"^[A-Za-z0-9_.:@-]{1,120}$")


def build_path(a: Action, venture_id: uuid.UUID, path: dict[str, Any] | None) -> str:
    out = a.path.replace("{venture_id}", str(venture_id))
    for p in a.path_params:
        if p == "venture_id":
            continue
        v = str((path or {}).get(p) or "")
        if not _SAFE_SEG.match(v):
            raise ActionError(f"give '{p}' in path (an id from an earlier lookup)")
        out = out.replace("{" + p + "}", v)
    return out


async def call(user_id: uuid.UUID, a: Action, venture_id: uuid.UUID, *, path: dict | None = None,
               query: dict | None = None, body: Any = None) -> dict[str, Any]:
    """Runs the action through the app itself as `user_id`. Returns {status, ok, result}."""
    from kritvia_api.main import app
    from kritvia_api.security import issue_access_token
    url = build_path(a, venture_id, path)
    if not allowed(a.method.lower(), a.path):
        raise ActionError("the assistant can't use that action; it's done on its page in Kritvia")
    if a.method == "POST" and a.path.endswith("/runs") and isinstance(body, dict) \
            and body.get("workflow") in NOT_STARTED_HERE:
        raise ActionError(f"the assistant can't start the {body.get('workflow')} agent; start it from its page")
    q = {k: v for k, v in (query or {}).items() if k in a.query and v is not None and not isinstance(v, dict | list)}
    transport = transport_override or httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://kritvia.internal", timeout=60) as client:
        r = await client.request(a.method, url, params=q,
                                 json=body if a.method != "GET" and body is not None else None,
                                 headers={"Authorization": f"Bearer {issue_access_token(user_id)}",
                                          "X-Kritvia-Via": "assistant"})
    ctype = r.headers.get("content-type", "")
    if "json" in ctype:
        data: Any = r.json() if r.content else None
    elif ctype.startswith("text/"):
        data = r.text
    else:
        data = f"(a file, {len(r.content)} bytes: open it on the page)"
    text_ = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False, default=str)
    if len(text_) > MAX_RESULT:
        text_ = text_[:MAX_RESULT] + " …(cut; ask for fewer with the action's filters)"
    return {"status": r.status_code, "ok": r.status_code < 400, "result": text_}
