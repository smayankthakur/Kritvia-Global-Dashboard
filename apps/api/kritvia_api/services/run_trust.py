"""Who a run acts for, and whether outside text has reached it: the assistant's trust boundary
(test report round 2, S1).

A request a signed-in person typed (in the app, in their linked Telegram/WhatsApp/Slack chat, or by owner email)
is theirs, and the assistant may look things up and answer it with the business's own records straight away.
What it must not do is let text someone *else* wrote (a customer's message, an email, a document, a web page, a
connected app's answer) steer it into sending the business's data somewhere. So:

  person      a signed-in person started this run (workflow_runs.started_by), so the request is theirs.
              Runs started by a schedule, an event, a routine or another agent have no person behind them.
  tainted     the first reason outside text reached the model in this run (a tool returned something an
              outsider could have written). Kept in the run's (encrypted) state.
  flagged     the prompt-injection guard flagged the run (model_router -> flag_run).

  may_reach_out = person and not tainted and not flagged

Tools that contact somewhere outside Kritvia at a destination the model chooses (web.browse, every
connected-app tool) run straight away only while `may_reach_out`; otherwise they become an approval card that
shows exactly where they go, with the address cleaned of query strings and fragments (`clean_url`). Reading the
business's own records is never gated: a person asking "how much is due this week?" gets the answer at once,
on any channel.

The answering machine uses the same pieces: `RunTrust.person` for "a known owner/staff member asked",
`taint()` when it hands customer text to a model, and `is_outward()`/`gate()` before contacting anything.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit, urlunsplit

from sqlalchemy import text

if TYPE_CHECKING:
    from kritvia_api.engine.context import RunContext

# Tools whose results are the business's own numbers or Kritvia's own catalogue: nothing an outsider wrote.
CLEAN_RESULTS = frozenset({"business.numbers", "kritvia.find"})
# Built-in tools that contact somewhere outside Kritvia at a destination the model picks.
OUTWARD = frozenset({"web.browse"})
APP_PREFIX = "app."          # connected-app (MCP) tools: app.<server>.<tool> (services.mcp.PREFIX)
STATE_KEY = "trust"


@dataclass(frozen=True)
class RunTrust:
    person: bool
    tainted: str | None
    flagged: bool

    @property
    def may_reach_out(self) -> bool:
        """Outward tools may run without a card: a person asked, and no outside text has reached the model."""
        return self.person and not self.tainted and not self.flagged


def is_outward(tool: str) -> bool:
    return tool in OUTWARD or tool.startswith(APP_PREFIX)


def taints(tool: str) -> bool:
    """Whether a tool's result can carry text an outsider wrote (almost all of them: lead names, messages,
    documents, bank narrations, app answers…)."""
    return tool not in CLEAN_RESULTS


def gate(trust: RunTrust, tool: str) -> bool:
    """True when this tool needs a person's yes in this run before it runs."""
    return is_outward(tool) and not trust.may_reach_out


def taint(state: dict[str, Any], why: str) -> dict[str, Any]:
    """Marks the run as having read outside text (the first reason is kept). Returns the state part to save."""
    t = state.setdefault(STATE_KEY, {})
    if not t.get("tainted"):
        t["tainted"] = why[:120]
    return {STATE_KEY: t}


def taint_input(state: dict[str, Any], why: str = "the request carries outside text") -> dict[str, Any]:
    """For runs whose input itself is someone else's words (a customer's message)."""
    return taint(state, why)


async def load(ctx: "RunContext", state: dict[str, Any]) -> RunTrust:
    """The run's trust now. `person` is read once and kept; `flagged` is read every time (the guard can flag
    the run at any model call)."""
    t = state.setdefault(STATE_KEY, {})
    async with ctx.tx() as conn:
        if "person" not in t:
            started_by = (await conn.execute(text("SELECT started_by FROM workflow_runs WHERE id = :r"),
                                             {"r": ctx.run_id})).scalar()
            t["person"] = started_by is not None
        flagged = bool((await conn.execute(text("SELECT run_flagged(:r)"), {"r": ctx.run_id})).scalar())
    return RunTrust(person=bool(t["person"]), tainted=t.get("tainted"), flagged=flagged)


def clean_url(url: str | None) -> str | None:
    """An address the model built, without the parts that can carry data out (user info, query, fragment).
    Only http(s); anything else is dropped."""
    raw = (url or "").strip()
    if not raw:
        return None
    try:
        u = urlsplit(raw if "://" in raw else "https://" + raw)
        if u.scheme not in ("http", "https") or not u.hostname:
            return None
        host = u.hostname + (f":{u.port}" if u.port else "")
    except ValueError:      # e.g. "javascript:alert(1)" read as a host with a bad port
        return None
    return urlunsplit((u.scheme, host, u.path or "/", "", ""))


__all__ = ["RunTrust", "load", "gate", "is_outward", "taints", "taint", "taint_input", "clean_url",
           "CLEAN_RESULTS", "OUTWARD"]
