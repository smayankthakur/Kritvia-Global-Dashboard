"""Plan limits: hosted-model tokens per month, ventures and members per organisation."""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass

from fastapi import HTTPException, status
from sqlalchemy import text

from kritvia_api.config import get_settings
from kritvia_api.plans import Plan, plan as plan_of


@dataclass
class Usage:
    plan: Plan
    tokens: int
    ventures: int
    members: int

    @property
    def tokens_left(self) -> int | None:
        lim = self.plan.monthly_tokens
        return None if lim is None else max(lim - self.tokens, 0)

    def as_dict(self) -> dict:
        return {"plan": self.plan.as_dict(), "tokens": self.tokens, "tokens_left": self.tokens_left,
                "ventures": self.ventures, "members": self.members}


async def org_usage(conn, org_id: uuid.UUID, local: list[str]) -> Usage | None:
    """None when the caller is not a member of the organisation."""
    row = (await conn.execute(text("SELECT * FROM org_usage(:o, :l)"), {"o": org_id, "l": local})).first()
    if row is None:
        return None
    return Usage(plan_of(row.plan or get_settings().default_plan), int(row.tokens), int(row.ventures),
                 int(row.members))


class TokenGate:
    """Caches each org's monthly usage briefly so not every model call costs a query."""

    def __init__(self, ttl_s: float = 30.0) -> None:
        self.ttl = ttl_s
        self._cache: dict[uuid.UUID, tuple[float, bool]] = {}
        self._agent_cache: dict[tuple[uuid.UUID, str], tuple[float, bool]] = {}

    def forget(self, org_id: uuid.UUID) -> None:
        self._cache.pop(org_id, None)

    def forget_agent(self, venture_id: uuid.UUID, workflow: str | None = None) -> None:
        """After an owner edits a budget on the board."""
        for key in [k for k in self._agent_cache if k[0] == venture_id and (workflow is None or k[1] == workflow)]:
            self._agent_cache.pop(key, None)

    async def agent_over_budget(self, conn, venture_id: uuid.UUID, workflow: str, local: list[str]) -> bool:
        """True when the owner set a monthly token budget for this agent and it is used up."""
        key = (venture_id, workflow)
        hit = self._agent_cache.get(key)
        if hit and hit[0] > time.monotonic():
            return hit[1]
        row = (await conn.execute(
            text("SELECT c.monthly_tokens, agent_usage(:v, :w, :l) AS used FROM workflow_configs c"
                 " WHERE c.venture_id = :v AND c.workflow = :w"),
            {"v": venture_id, "w": workflow, "l": local})).first()
        over = bool(row and row.monthly_tokens is not None and int(row.used) >= int(row.monthly_tokens))
        self._agent_cache[key] = (time.monotonic() + self.ttl, over)
        return over

    async def over_limit(self, conn, org_id: uuid.UUID, local: list[str]) -> bool:
        hit = self._cache.get(org_id)
        if hit and hit[0] > time.monotonic():
            return hit[1]
        u = await org_usage(conn, org_id, local)
        over = bool(u and u.tokens_left == 0)
        self._cache[org_id] = (time.monotonic() + self.ttl, over)
        return over


async def require_room(conn, org_id: uuid.UUID, what: str, local: list[str]) -> None:
    """Refuses (402) a new venture or member beyond the plan."""
    u = await org_usage(conn, org_id, local)
    if u is None:
        return  # not a member: the caller's own authorisation check answers
    lim = u.plan.max_ventures if what == "venture" else u.plan.max_members
    used = u.ventures if what == "venture" else u.members
    if lim is not None and used >= lim:
        noun = ("business" if lim == 1 else "businesses") if what == "venture" else ("person" if lim == 1 else "people")
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED,
                            f"the {u.plan.name} plan includes {lim} {noun}; upgrade to add more")
