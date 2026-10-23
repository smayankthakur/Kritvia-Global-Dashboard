"""Tool registry and policy engine.

Every tool declares one capability class:

  read     runs silently; each invocation is written to the audit log
  write    changes a record outside the workflow's own tables -> needs an approval
  send     leaves the building (email, invite, PO) -> needs an approval; auto-run
           only after the (agent, action) pair is explicitly promoted
  execute  runs code; only ever inside the sandbox

For write/send the caller passes the approval id, NOT the arguments: the tool
executes exactly the payload a human approved (or edited), read back from the
database. Execution is claimed atomically, so an approval can fire at most once
even if the worker crashes and the step is retried.
"""
from __future__ import annotations

import json
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING, Any

from sqlalchemy import text

if TYPE_CHECKING:
    from kritvia_api.engine.context import RunContext


class Capability(StrEnum):
    READ = "read"
    WRITE = "write"
    SEND = "send"
    EXECUTE = "execute"


class PolicyError(Exception):
    """An agent tried something the policy engine does not allow."""


class AlreadyExecuted(Exception):
    """The approved action already ran (a step re-run after a restart). `result` is what it recorded:
    {} when the worker stopped before recording it (it may or may not have gone out: never sent twice)."""

    def __init__(self, result: dict[str, Any] | None) -> None:
        super().__init__("approval already executed")
        self.result = result or {}


# A send that failed (recorded ok: false) may be tried again, up to this many times in all.
MAX_ATTEMPTS = 3


Handler = Callable[["RunContext", dict[str, Any], "ApprovedAction | None"], Awaitable[dict[str, Any]]]


@dataclass
class ApprovedAction:
    id: uuid.UUID
    agent: str
    action: str
    status: str
    payload: dict[str, Any]
    attempt: int = 1


@dataclass
class Tool:
    name: str
    capability: Capability
    description: str
    handler: Handler


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> Tool:
        if tool.name in self._tools:
            raise ValueError(f"tool {tool.name!r} registered twice")
        self._tools[tool.name] = tool
        return tool

    def tool(self, name: str, capability: Capability, description: str):
        def deco(fn: Handler) -> Handler:
            self.register(Tool(name, capability, description, fn))
            return fn
        return deco

    def get(self, name: str) -> Tool:
        if name not in self._tools:
            raise PolicyError(f"unknown tool {name!r}")
        return self._tools[name]

    def capability(self, name: str) -> Capability:
        return self.get(name).capability

    def catalogue(self) -> list[dict[str, str]]:
        return [{"name": t.name, "capability": t.capability.value, "description": t.description}
                for t in sorted(self._tools.values(), key=lambda t: t.name)]

    async def invoke(self, ctx: RunContext, name: str, args: dict[str, Any], *,
                     approval_id: uuid.UUID | str | None = None) -> dict[str, Any]:
        tool = self.get(name)
        if tool.capability in (Capability.READ, Capability.EXECUTE):
            if approval_id is not None:
                raise PolicyError(f"{name} is {tool.capability}; it does not take an approval")
            async with ctx.tx() as conn:
                await conn.execute(
                    text("SELECT audit_event(:o, :v, :a, 'tool', :t, CAST(:d AS jsonb))"),
                    {"o": ctx.org_id, "v": ctx.venture_id, "a": f"tool.{tool.capability}", "t": name,
                     "d": json.dumps({"run_id": str(ctx.run_id)})})
            return await tool.handler(ctx, args, None)

        # write / send: only with a decided approval for THIS run and THIS tool
        if approval_id is None:
            raise PolicyError(f"{name} is a {tool.capability} action and requires an approval")
        approved = await self._claim(ctx, name, uuid.UUID(str(approval_id)))
        try:
            result = await tool.handler(ctx, approved.payload, approved)
        except Exception as exc:
            # Only what kind of failure it was, never the provider's reply (it can quote the draft or the
            # customer's details, and execution_result isn't encrypted).
            await self._record(ctx, approved.id, {"ok": False, "error": type(exc).__name__, "why": _reason(exc),
                                                  "attempt": approved.attempt})
            raise
        await self._record(ctx, approved.id, {"ok": True, **_safe(result)})
        if approved.status == "auto_approved":
            async with ctx.tx() as conn:
                await conn.execute(text("SELECT record_auto_execution(:v, :a, :t)"),
                                   {"v": ctx.venture_id, "a": approved.agent, "t": approved.action})
        return result

    async def _claim(self, ctx: RunContext, name: str, approval_id: uuid.UUID) -> ApprovedAction:
        async with ctx.tx() as conn:
            row = (await conn.execute(
                text("SELECT id, run_id, agent, action, status, final_payload_enc, executed_at,"
                     " execution_result FROM approvals WHERE id = :id AND venture_id = :v FOR UPDATE"),
                {"id": approval_id, "v": ctx.venture_id})).first()
            if row is None or row.run_id != ctx.run_id:
                raise PolicyError("approval does not belong to this run")
            if row.action != name:
                raise PolicyError(f"approval is for {row.action!r}, not {name!r}")
            if row.status not in ("approved", "edited", "auto_approved"):
                raise PolicyError(f"approval is {row.status}; nothing may execute")
            attempt = 1
            if row.executed_at is not None:
                done = row.execution_result if isinstance(row.execution_result, dict) else {}
                # It went out, or the worker stopped before recording what happened (maybe sent): never twice.
                # A send that is known to have failed may be tried again (a passing problem, a manual retry).
                attempt = int(done.get("attempt") or 1) + 1
                if done.get("ok") is not False or attempt > MAX_ATTEMPTS:
                    raise AlreadyExecuted(done)
                again = (await conn.execute(text("SELECT private.retry_failed_execution(:id)"),
                                            {"id": approval_id})).scalar()
                if not again:
                    raise AlreadyExecuted(done)
            else:
                await conn.execute(text("UPDATE approvals SET executed_at = now() WHERE id = :id"),
                                   {"id": approval_id})
            payload = json.loads(await ctx.crypto(conn).decrypt(ctx.venture_id, "approvals.payload",
                                                                row.final_payload_enc))
        return ApprovedAction(approval_id, row.agent, row.action, row.status, payload, attempt)

    async def _record(self, ctx: RunContext, approval_id: uuid.UUID, result: dict[str, Any]) -> None:
        async with ctx.tx() as conn:
            await conn.execute(
                text("UPDATE approvals SET execution_result = CAST(:r AS jsonb) WHERE id = :id"),
                {"id": approval_id, "r": json.dumps(result, default=str)})


# Keys that can carry what was said or what a provider answered: never kept in execution_result.
_UNSAFE_EXACT = {"message", "text", "reply", "why", "title", "url", "summary", "note", "subject", "to", "name"}
_UNSAFE_PARTS = ("body", "response", "error", "detail", "content", "html", "snippet", "preview", "email", "phone")


def _safe(result: dict[str, Any]) -> dict[str, Any]:
    """Only small scalar metadata goes into execution_result (it is not encrypted, and people who can't
    approve may see a card's status): ids, statuses and counts, not text."""
    return {k: v for k, v in result.items()
            if isinstance(v, str | int | float | bool) and k.lower() not in _UNSAFE_EXACT
            and not any(u in k.lower() for u in _UNSAFE_PARTS)
            and (not isinstance(v, str) or len(v) <= 120)}


def _reason(exc: BaseException) -> str:
    """A short, generic reason for a failed action, for the card and the retry decision."""
    import asyncio

    import httpx
    if isinstance(exc, asyncio.TimeoutError | TimeoutError | httpx.TimeoutException):
        return "timed out"
    if isinstance(exc, httpx.TransportError | ConnectionError):
        return "couldn't reach the service"
    if isinstance(exc, PolicyError):
        return "not allowed"
    name = type(exc).__name__.lower()
    if "quota" in name or "ratelimit" in name:
        return "rate limited"
    return "the service refused it"
