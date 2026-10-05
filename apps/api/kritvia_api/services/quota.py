"""Plan limits: hosted-model tokens per month, businesses, people and business memory per
organisation, and which agents and integrations a plan includes."""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException, status
from sqlalchemy import text

from kritvia_api.config import get_settings
from kritvia_api.plans import AGENT_NAMES, INTEGRATION_NAMES, PLANS, Plan, plan as plan_of

GRACE_AFTER_PAYMENTS = timedelta(days=3)


@dataclass
class Trial:
    ends_at: datetime | None     # None: held open until online payment is live
    expired: bool

    def as_dict(self) -> dict:
        days = None
        if self.ends_at is not None and not self.expired:
            days = max(0, (self.ends_at - datetime.now(UTC)).days + 1)
        return {"ends_at": self.ends_at.isoformat() if self.ends_at else None, "expired": self.expired,
                "held": self.ends_at is None, "days_left": days}


def trial_for(plan_code: str | None, trial_ends_at: datetime | None, now: datetime | None = None) -> Trial | None:
    """The trial, for an organisation on the Free plan; None for paid and internal plans."""
    if plan_of(plan_code or get_settings().default_plan).code != "free" or trial_ends_at is None:
        return None
    live = get_settings().payments_live_at
    if live is None:
        return Trial(None, False)
    if live.tzinfo is None:
        live = live.replace(tzinfo=UTC)
    ends = max(trial_ends_at, live + GRACE_AFTER_PAYMENTS)
    return Trial(ends, (now or datetime.now(UTC)) >= ends)


def effective_plan(plan_code: str | None, trial_ends_at: datetime | None) -> Plan:
    """The plan that applies now: a Free trial that has ended is read-only ("expired")."""
    t = trial_for(plan_code, trial_ends_at)
    return PLANS["expired"] if t and t.expired else plan_of(plan_code or get_settings().default_plan)


class TrialEnded(Exception):
    pass


READ_ONLY_MESSAGE = ("Your 15-day free trial has ended, so this organisation is read-only. Choose a plan in "
                     "Plan & billing to keep working; you can still view, export and delete your data.")


@dataclass
class Usage:
    plan: Plan
    tokens: int
    ventures: int
    members: int
    storage: int = 0
    trial: Trial | None = None

    @property
    def tokens_left(self) -> int | None:
        lim = self.plan.monthly_tokens
        return None if lim is None else max(lim - self.tokens, 0)

    def as_dict(self) -> dict:
        return {"plan": self.plan.as_dict(), "tokens": self.tokens, "tokens_left": self.tokens_left,
                "ventures": self.ventures, "members": self.members, "storage_bytes": self.storage,
                "trial": self.trial.as_dict() if self.trial else None, "read_only": self.plan.code == "expired"}


async def org_usage(conn, org_id: uuid.UUID, local: list[str]) -> Usage | None:
    """None when the caller is not a member of the organisation."""
    row = (await conn.execute(text("SELECT * FROM org_usage(:o, :l)"), {"o": org_id, "l": local})).first()
    if row is None:
        return None
    ends = (await conn.execute(text("SELECT trial_ends_at FROM org_plan_state(:o)"), {"o": org_id})).scalar()
    return Usage(effective_plan(row.plan, ends), int(row.tokens), int(row.ventures),
                 int(row.members), int(row.storage), trial_for(row.plan, ends))


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
                            f"{u.plan.label} includes {lim} {noun}; upgrade to add more")


class PlanRestricted(ValueError):
    """The organisation's plan does not include this agent, integration or amount."""


def _human_bytes(n: int) -> str:
    return f"{n / 1024 ** 3:.1f} GB" if n >= 1024 ** 3 else f"{max(n, 0) / 1024 ** 2:.0f} MB"


async def plan_for_venture(conn, venture_id: uuid.UUID) -> Plan:
    row = (await conn.execute(text("SELECT plan, trial_ends_at FROM venture_plan_state(:v)"), {"v": venture_id})).first()
    return effective_plan(row.plan if row else None, row.trial_ends_at if row else None)


async def read_only(conn, *, venture_id: uuid.UUID | None = None, org_id: uuid.UUID | None = None) -> bool:
    """True when the organisation's free trial has ended without a plan being chosen."""
    if venture_id is not None:
        row = (await conn.execute(text("SELECT plan, trial_ends_at FROM venture_plan_state(:v)"), {"v": venture_id})).first()
    else:
        row = (await conn.execute(text("SELECT plan, trial_ends_at FROM org_plan_state(:o)"), {"o": org_id})).first()
    return bool(row) and effective_plan(row.plan, row.trial_ends_at).code == "expired"


def upgrade_hint(p: Plan) -> str:
    return {"free": "Starter", "expired": "a plan", "starter": "Growth", "growth": "Scale"}.get(p.code, "a bigger plan")


async def require_agent(conn, venture_id: uuid.UUID, workflow: str, kind: str | None) -> None:
    p = await plan_for_venture(conn, venture_id)
    if not p.allows_agent(workflow, kind):
        name = AGENT_NAMES.get(workflow, workflow)
        raise PlanRestricted(f"{p.label} doesn't include {name}; upgrade to {upgrade_hint(p)} to switch it on")


async def require_integration(conn, venture_id: uuid.UUID, integration: str) -> None:
    p = await plan_for_venture(conn, venture_id)
    if not p.allows_integration(integration):
        name = INTEGRATION_NAMES.get(integration, integration)
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED,
                            f"{p.label} doesn't include {name}; upgrade to {upgrade_hint(p)} to connect it")


async def require_storage(conn, org_id: uuid.UUID, adding: int, local: list[str]) -> None:
    """Refuses (402) a new document or recording that would take business memory past the plan."""
    u = await org_usage(conn, org_id, local)
    if u is None or u.plan.storage_bytes is None:
        return
    if u.storage + adding > u.plan.storage_bytes:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED,
                            f"business memory is full on {u.plan.label} ({_human_bytes(u.storage)} of "
                            f"{_human_bytes(u.plan.storage_bytes)} used); delete documents or upgrade to "
                            f"{upgrade_hint(u.plan)}")
