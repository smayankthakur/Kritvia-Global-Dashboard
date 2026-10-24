"""Durable workflow runner.

Lifecycle:  queued -> running -> (waiting -> queued -> running)* -> completed | failed | cancelled

* A worker CLAIMS a run with a lease (UPDATE ... WHERE status = 'queued' OR the
  lease expired). Two workers can never execute the same run concurrently, and
  a crashed worker's run is picked up again by the sweeper once its lease ends.
* After every step the state is re-encrypted and checkpointed together with the
  next step name, under the lease. A lost lease aborts without writing.
* An Interrupt creates an approval row and parks the run as 'waiting'. The
  decision (decide_approval) re-queues it; on resume the decision and the final
  (possibly edited) payload are written into state before the next step runs.
* Earned autonomy: if the (agent, action) pair has been promoted, the approval
  is created as auto_approved and the run continues without stopping.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from datetime import timedelta
from typing import Any

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.db.session import tenant_tx
from kritvia_api.engine.context import RunContext, Services
from kritvia_api.engine.core import Finish, Goto, Interrupt, registry
from kritvia_api.services.crypto import EnvelopeCrypto
from kritvia_api.services import push
from kritvia_api.services.model_router import AgentBudgetExceeded
from kritvia_api.services import guardrails
from kritvia_api.services.quota import require_agent
from kritvia_api.services.security_log import security_event

log = logging.getLogger("kritvia.runner")

STATE_PURPOSE = "workflow_runs.state"
PAYLOAD_PURPOSE = "approvals.payload"
LEASE = timedelta(minutes=10)
MAX_RECLAIMS = 3          # a step that stops this many times without finishing fails the run
PENDING = "__pending_approval"


class LeaseLost(Exception):
    pass


class DuplicateTrigger(Exception):
    """The same external event already started a run."""


def _dump(state: dict[str, Any]) -> bytes:
    return json.dumps(state, default=str, separators=(",", ":")).encode()


# ---------------------------------------------------------------------------
# Starting runs
# ---------------------------------------------------------------------------
async def start_run(
    services: Services,
    *,
    actor_user_id: uuid.UUID,
    actor_type: str = "user",
    venture_id: uuid.UUID,
    workflow: str,
    input: dict[str, Any],
    title: str = "",
    trigger_kind: str = "manual",
    trigger_ref: str | None = None,
    dedupe: tuple[str, str] | None = None,
    dispatch: bool = True,
    delegated_from: str | None = None,
) -> uuid.UUID:
    """Create a queued run. The caller needs write access to the venture (RLS).

    `dedupe=(source, external_id)` makes the start idempotent for external
    triggers: a second delivery of the same email/webhook raises DuplicateTrigger.
    """
    wf = registry.get(workflow)
    agent = "trigger" if actor_type != "user" else None
    async with tenant_tx(actor_user_id, actor_type, agent) as conn:  # type: ignore[arg-type]
        v = (await conn.execute(
            text("SELECT v.org_id, venture_service_account(v.id) AS run_as,"
                 " coalesce(s.kind, 'general') AS kind,"
                 " coalesce(c.enabled, true) AS enabled"
                 " FROM ventures v LEFT JOIN venture_settings s ON s.venture_id = v.id"
                 " LEFT JOIN workflow_configs c ON c.venture_id = v.id AND c.workflow = :w"
                 " WHERE v.id = :v"),
            {"v": venture_id, "w": workflow})).first()
        if v is None or v.run_as is None:
            raise LookupError("venture not found")
        if v.kind not in wf.venture_kinds:
            raise ValueError(f"workflow {workflow} does not apply to a {v.kind} venture")
        if not v.enabled:
            raise ValueError(f"workflow {workflow} is disabled for this venture")
        await require_agent(conn, venture_id, workflow, v.kind)   # PlanRestricted when the plan lacks it
        if actor_type == "user" and wf.authorize_input is not None:
            await wf.authorize_input(conn, venture_id, input)

        run_id = uuid.uuid4()
        if dedupe:
            inserted = (await conn.execute(
                text("INSERT INTO trigger_events (org_id, venture_id, source, external_id, run_id)"
                     " VALUES (:o, :v, :s, :x, :r) ON CONFLICT DO NOTHING RETURNING id"),
                {"o": v.org_id, "v": venture_id, "s": dedupe[0], "x": dedupe[1][:500], "r": run_id})).first()
            if inserted is None:
                raise DuplicateTrigger(f"{dedupe[0]}:{dedupe[1]}")

        state_enc = await EnvelopeCrypto(conn, services.keys).encrypt(
            venture_id, STATE_PURPOSE, _dump({"input": input}))
        await conn.execute(
            text("INSERT INTO workflow_runs (id, org_id, venture_id, workflow, version, title, current_step,"
                 " state_enc, trigger_kind, trigger_ref, run_as, started_by)"
                 " VALUES (:id, :o, :v, :w, :ver, :t, :s, :st, :tk, :tr, :ra, :sb)"),
            {"id": run_id, "o": v.org_id, "v": venture_id, "w": workflow, "ver": wf.version,
             "t": (title or wf.title)[:200], "s": wf.start, "st": state_enc, "tk": trigger_kind,
             "tr": trigger_ref, "ra": v.run_as, "sb": actor_user_id if actor_type == "user" else None})
        # The board card for this run. Role comes from the venture's agent config (default 'ops').
        await conn.execute(
            text("INSERT INTO tickets (org_id, venture_id, run_id, workflow, role, title, created_by, delegated_from)"
                 " VALUES (:o, :v, :r, :w, coalesce((SELECT role FROM workflow_configs"
                 " WHERE venture_id = :v AND workflow = :w), 'ops'), :t, :by, :df)"),
            {"o": v.org_id, "v": venture_id, "r": run_id, "w": workflow, "t": (title or wf.title)[:200],
             "by": actor_user_id if actor_type == "user" else None,
             "df": delegated_from})
    if dispatch:
        try:
            await services.dispatcher.enqueue_run(run_id)
        except Exception:  # noqa: BLE001 - the run is saved as queued: the sweeper starts it once the queue is back
            log.warning("run %s saved but not queued (queue unavailable); the sweeper will start it", run_id,
                        exc_info=True)
    return run_id


# ---------------------------------------------------------------------------
# Executing runs
# ---------------------------------------------------------------------------
async def run_principal(run_id: uuid.UUID) -> uuid.UUID | None:
    async with tenant_tx(None, "system") as conn:
        return (await conn.execute(text("SELECT private.run_principal(:r)"), {"r": run_id})).scalar_one()


async def advance_run(services: Services, run_id: uuid.UUID, max_steps: int | None = None) -> str | None:
    """Execute a run until it waits, finishes or fails. Returns the final status."""
    run_as = await run_principal(run_id)
    if run_as is None:
        return None
    worker = services.worker_id

    async with tenant_tx(run_as, "agent", "runtime") as conn:
        row = (await conn.execute(
            text("UPDATE workflow_runs SET status = 'running', lease_owner = :w,"
                 " lease_until = now() + :lease, updated_at = now(), error = NULL"
                 " WHERE id = :id AND (status = 'queued' OR (status = 'running' AND lease_until < now()))"
                 " RETURNING org_id, venture_id, workflow, current_step, state_enc, step_count, trigger_kind,"
                 " (SELECT id FROM tickets t WHERE t.run_id = workflow_runs.id) AS ticket_id"),
            {"id": run_id, "w": worker, "lease": LEASE})).first()
        if row is None:
            return None  # someone else holds it, or it is not runnable
        state = json.loads(await EnvelopeCrypto(conn, services.keys).decrypt(
            row.venture_id, STATE_PURPOSE, row.state_enc))

    wf = registry.get(row.workflow)
    ctx = RunContext(run_id=run_id, org_id=row.org_id, venture_id=row.venture_id, run_as=run_as,
                     workflow=row.workflow, services=services, trigger_kind=row.trigger_kind,
                     ticket_id=row.ticket_id)
    step_name, step_count = row.current_step, row.step_count
    limit = max_steps or wf.max_steps

    try:
        # Resuming after a human decision?
        if PENDING in state:
            nxt = await _apply_decision(ctx, state)
            if nxt is None:
                await _park(ctx, state, step_name, step_count)
                return "waiting"
            if isinstance(nxt, Finish):
                await _finish(ctx, state, nxt.outcome, step_count, "completed")
                return "completed"
            step_name = nxt

        while True:
            if step_count >= limit:
                raise RuntimeError(f"step limit ({limit}) exceeded — possible loop")
            spec = wf.steps.get(step_name)
            if spec is None:
                raise RuntimeError(f"workflow {wf.name} has no step {step_name!r}")
            ctx.agent, ctx.notes = spec.agent, []
            started = time.perf_counter()
            try:
                result = await spec.fn(ctx, state)
            except Exception as exc:
                step_count += 1
                await _log_step(ctx, step_name, "failed", started, error=_err(exc))
                raise
            step_count += 1
            state.update(getattr(result, "update", {}) or {})
            note = getattr(result, "note", None) or ("; ".join(ctx.notes) if ctx.notes else None)

            if isinstance(result, Goto):
                await _log_step(ctx, step_name, "ok", started, note=note)
                step_name = result.step
                await _checkpoint(ctx, state, step_name, step_count)
                continue

            if isinstance(result, Finish):
                await _log_step(ctx, step_name, "ok", started, note=note)
                await _finish(ctx, state, result.outcome, step_count, "completed")
                return "completed"

            if isinstance(result, Interrupt):
                # The card and the run's 'waiting' state are written in one transaction (with the card
                # reused if this step already made one), so a crash can't leave a card whose yes wakes
                # nothing, or two cards for one draft.
                auto = await _create_approval(ctx, state, step_name, result, step_count=step_count)
                if auto:
                    why = (f"the business switched on {result.request.auto_option}"
                           if auto == "option" else "earned autonomy")
                    await _log_step(ctx, step_name, "ok", started, note=(note or "") + f" [auto-approved: {why}]")
                    step_name = result.resume
                    await _checkpoint(ctx, state, step_name, step_count)
                    continue
                await _log_step(ctx, step_name, "interrupted", started, note=note or "awaiting approval")
                return "waiting"

            raise TypeError(f"step {step_name} returned {type(result).__name__}, not a StepResult")
    except LeaseLost:
        log.warning("run %s: lease lost, abandoning", run_id)
        return None
    except asyncio.CancelledError:
        # The job ran out of time, or the worker is stopping (a deploy). CancelledError isn't an Exception,
        # so nothing below sees it: give the run back at once (the sweeper re-queues it and counts the
        # attempt; after MAX_RECLAIMS it fails instead of looping), then let the cancellation through.
        log.warning("run %s stopped at %s (timed out or worker stopping)", run_id, step_name)
        try:
            await asyncio.shield(_release(ctx))
        except Exception:  # noqa: BLE001 - the lease expires by itself within LEASE
            log.exception("could not release run %s", run_id)
        raise
    except AgentBudgetExceeded as exc:
        # Not a failure: the owner capped this agent. Park on the same step so a retry
        # (or next month) picks it up where it stopped, and say so on the board.
        log.info("run %s parked at %s: %s", run_id, step_name, exc)
        state.setdefault("summary", {})["blocked"] = "budget"
        await _park(ctx, state, step_name, step_count, ticket_status="blocked",
                    ticket_note="Paused: this agent's monthly budget is used up. It carries on by itself"
                                " when the budget is raised or a new month starts")
        return "waiting"
    except Exception as exc:
        log.exception("run %s failed at %s", run_id, step_name)
        await _fail(ctx, state, step_name, step_count, _err(exc))
        if passing(exc) and await _retry_later(ctx, _err(exc)):
            return "retrying"
        return "failed"


_PASSING_TEXT = re.compile(r"HTTP (429|5\d\d)\b|timed? ?out|temporarily|connection (reset|refused|closed)|"
                           r"rate.?limit|too many requests|service unavailable|bad gateway", re.I)


def passing(exc: BaseException) -> bool:
    """A failure that is likely to go away by itself (worth trying the run again later): a timeout or a dropped
    connection, an AI provider or Google answering 5xx/429, every AI provider failing at once, a database
    deadlock or restart. Not: bad input, a policy refusal, a missing setting."""
    import httpx
    from sqlalchemy.exc import DBAPIError, OperationalError

    from kritvia_api.engine.tools import PolicyError
    from kritvia_api.services.model_router import AiPaused, AllProvidersFailed, QuotaExceeded
    if isinstance(exc, AiPaused):          # the kill switch: try again later, by itself
        return True
    if isinstance(exc, PolicyError | QuotaExceeded | ValueError | KeyError | TypeError | AssertionError):
        return False
    if isinstance(exc, httpx.TransportError | asyncio.TimeoutError | TimeoutError | ConnectionError
                  | AllProvidersFailed | OperationalError):
        return True
    if isinstance(exc, DBAPIError):
        code = getattr(getattr(exc, "orig", None), "sqlstate", None) or ""
        return code in ("40001", "40P01", "57P01", "57P03") or code.startswith("08")
    return bool(_PASSING_TEXT.search(str(exc)[:500]))


async def _retry_later(ctx: RunContext, error: str) -> int:
    """Puts the failed run back on the queue after a pause; 0 when it has had its three retries."""
    try:
        async with tenant_tx(None, "system") as conn:
            n = int((await conn.execute(text("SELECT private.retry_later(:r, :e)"),
                                        {"r": ctx.run_id, "e": error[:1000]})).scalar() or 0)
            if n:
                wait = {1: 2, 2: 10}.get(n, 60)
                await conn.execute(text("SELECT ticket_for_run(:r, 'open', :n)"),
                                   {"r": ctx.run_id, "n": f"Hit a passing problem; trying again by itself in {wait} min"})
        if n:
            log.info("run %s will be retried (attempt %d)", ctx.run_id, n + 1)
        return n
    except Exception:  # noqa: BLE001 - a retry that can't be booked leaves the run failed, as before
        log.exception("could not book a retry for %s", ctx.run_id)
        return 0


def _err(exc: BaseException) -> str:
    """Error text shown to every reader of the run: never include input values
    (SQL parameters, validated payloads) — they may carry personal data."""
    from pydantic import ValidationError
    from sqlalchemy.exc import DBAPIError

    if isinstance(exc, DBAPIError):
        msg = str(getattr(exc, "orig", exc)).split("\n")[0]
        msg = msg.split(": ", 1)[-1] if msg.startswith("<class") else msg
    elif isinstance(exc, ValidationError):
        msg = "; ".join(f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}"
                        for e in exc.errors(include_input=False, include_url=False))
    else:
        msg = str(exc).split("\n[SQL")[0]
    return f"{type(exc).__name__}: {msg}"[:1000]


async def _write_state(ctx: RunContext, conn, state: dict[str, Any], sets: str, params: dict) -> None:
    enc = await ctx.crypto(conn).encrypt(ctx.venture_id, STATE_PURPOSE, _dump(state))
    res = await conn.execute(
        text(f"UPDATE workflow_runs SET state_enc = :st, updated_at = now(), {sets}"
             " WHERE id = :id AND lease_owner = :w"),
        {"st": enc, "id": ctx.run_id, "w": ctx.services.worker_id, **params})
    if res.rowcount != 1:
        raise LeaseLost()


async def _release(ctx: RunContext) -> None:
    """Hands a running run back (its lease ends now); the sweeper re-queues it within a minute."""
    async with ctx.tx("runtime") as conn:
        await conn.execute(text(
            "UPDATE workflow_runs SET lease_until = now() - interval '1 second', updated_at = now()"
            " WHERE id = :id AND lease_owner = :w AND status = 'running'"),
            {"id": ctx.run_id, "w": ctx.services.worker_id})


async def _checkpoint(ctx: RunContext, state, step: str, step_count: int) -> None:
    async with ctx.tx("runtime") as conn:
        await _write_state(ctx, conn, state,
                           "current_step = :s, step_count = :n, lease_until = now() + :lease, reclaims = 0,"
                           " summary = CAST(:sum AS jsonb)",
                           {"s": step, "n": step_count, "lease": LEASE,
                            "sum": json.dumps(state.get("summary", {}), default=str)})


async def _park(ctx: RunContext, state, resume_step: str, step_count: int, *,
                ticket_status: str = "waiting_approval", ticket_note: str | None = None) -> None:
    async with ctx.tx("runtime") as conn:
        await _write_state(ctx, conn, state,
                           "status = 'waiting', current_step = :s, step_count = :n, lease_owner = NULL,"
                           " lease_until = NULL, summary = CAST(:sum AS jsonb)",
                           {"s": resume_step, "n": step_count,
                            "sum": json.dumps(state.get("summary", {}), default=str)})
        await _move_ticket(conn, ctx, ticket_status, ticket_note)


async def _move_ticket(conn, ctx: RunContext, status: str, note: str | None = None) -> None:
    if ctx.ticket_id is None:
        return
    await conn.execute(text("SELECT ticket_for_run(:r, :s, :n)"), {"r": ctx.run_id, "s": status, "n": note})


async def _finish(ctx: RunContext, state, outcome: str, step_count: int, status: str) -> None:
    async with ctx.tx("runtime") as conn:
        await _write_state(ctx, conn, state,
                           "status = :status, outcome = :o, step_count = :n, lease_owner = NULL,"
                           " lease_until = NULL, finished_at = now(), summary = CAST(:sum AS jsonb)",
                           {"status": status, "o": outcome[:100], "n": step_count,
                            "sum": json.dumps(state.get("summary", {}), default=str)})
        await _move_ticket(conn, ctx, "done", outcome[:100])


async def _fail(ctx: RunContext, state, step: str, step_count: int, error: str) -> None:
    try:
        async with ctx.tx("runtime") as conn:
            await _write_state(ctx, conn, state,
                               "status = 'failed', current_step = :s, step_count = :n, error = :e,"
                               " lease_owner = NULL, lease_until = NULL, finished_at = now()",
                               {"s": step, "n": step_count, "e": error})
            await _move_ticket(conn, ctx, "blocked", error.split(": ", 1)[-1][:200])
    except LeaseLost:
        pass


async def _log_step(ctx: RunContext, step: str, status: str, started: float, *,
                    note: str | None = None, error: str | None = None) -> None:
    async with ctx.tx("runtime") as conn:
        await conn.execute(
            text("INSERT INTO workflow_steps (org_id, venture_id, run_id, step, agent, status, note, error,"
                 " duration_ms) VALUES (:o, :v, :r, :s, :a, :st, :n, :e, :d)"),
            {"o": ctx.org_id, "v": ctx.venture_id, "r": ctx.run_id, "s": step, "a": ctx.agent,
             "st": status, "n": note[:500] if note else None, "e": error,
             "d": int((time.perf_counter() - started) * 1000)})


AUTO_REPLY_OPTIONS = ("auto_reply", "answer_facts")


async def _reserve_auto_slot(conn, ctx: RunContext, state: dict, req) -> bool:
    """Under a per-business lock, check the automatic-reply limits once more and mark this run as one that
    replies by itself, so a run checking at the same moment counts it. False: the draft waits for a yes."""
    if req.auto_option not in AUTO_REPLY_OPTIONS:
        return True
    from kritvia_api.services import auto_reply as ar
    from kritvia_api.services import customer_facts as cf
    await conn.execute(text("SELECT pg_advisory_xact_lock(hashtext(:k))"), {"k": f"auto-reply:{ctx.venture_id}"})
    summary = state.setdefault("summary", {})
    channel = "email" if req.action == "gmail.send" else req.action.split(".", 1)[0]
    if req.auto_option == "answer_facts":
        key = summary.get("fact_to") or ""
        if await cf.recent_auto_answers(conn, ctx.venture_id, key) >= cf.AUTO_PER_HOUR:
            return False
        mark = {"fact_auto": True}
    else:
        key = summary.get("auto_to") or ""
        if not await ar.room(conn, ctx.venture_id, key, channel=channel):
            return False
        mark = {"auto_pending": True, "auto_channel": channel}
    summary.update(mark)
    await conn.execute(text("UPDATE workflow_runs SET summary = summary || CAST(:j AS jsonb) WHERE id = :r"),
                       {"j": json.dumps(mark), "r": ctx.run_id})
    return True


async def _create_approval(ctx: RunContext, state: dict, step: str, it: Interrupt, *,
                           step_count: int) -> str | None:
    """Insert the approval (or reuse the one this step already made) and, unless it is auto-approved
    (earned autonomy, or a workflow option the business switched on: ApprovalRequest.auto_option), park the
    run as waiting in the same transaction. Returns "trust" or "option" if auto-approved, else None."""
    req = it.request
    cap = ctx.services.tools.capability(req.action)
    if cap.value not in ("write", "send"):
        raise ValueError(f"approvals are for write/send tools; {req.action} is {cap}")
    by_option = bool(req.auto_option) and (await ctx.settings()).get(req.auto_option) is True
    async with ctx.tx(req.agent) as conn:
        trusted = bool((await conn.execute(
            text("SELECT auto_run FROM agent_trust WHERE venture_id = :v AND agent = :a AND action = :t"),
            {"v": ctx.venture_id, "a": req.agent, "t": req.action})).scalar())
        # Autopilot (services/autopilot.py): routine work the workflow marked, when the business switched it
        # on and its plan allows the agent's action; the database guard has the last word (migration 0080).
        by_autopilot = False
        if req.autopilot and not trusted and not by_option:
            from kritvia_api.services import autopilot
            by_autopilot = await autopilot.allowed(conn, ctx.venture_id, req.agent, req.action)
        # A sensitive draft, or one marked for review, is never auto-approved, whatever its history.
        auto = (trusted or by_option or by_autopilot) and not req.sensitive and not req.always_review
        if auto:
            # Guardrails: a run that read text trying to instruct the AI, or a draft carrying a secret
            # or injection text, waits for a person even though the agent earned autonomy.
            flagged = bool((await conn.execute(text("SELECT run_flagged(:r)"), {"r": ctx.run_id})).scalar())
            reasons = guardrails.check_draft(json.dumps(req.payload, default=str, ensure_ascii=False))
            if flagged or reasons:
                auto = False
                await security_event("ai.autonomy_withheld", "warning", org_id=ctx.org_id, workflow=ctx.workflow,
                                     action=req.action, reasons=",".join(reasons) or "run flagged")
        if auto and (by_option or by_autopilot) and not trusted:
            # Replying by itself has per-person and per-business limits. Checking them earlier in the step
            # isn't enough when several messages arrive at once (round 3, B4): check again here, one run
            # at a time per business, and reserve the slot on the run before the lock is released.
            auto = await _reserve_auto_slot(conn, ctx, state, req)
        existing = None
        if not auto:
            # This step already made a card that is still waiting (it ran again after a restart): use it.
            existing = (await conn.execute(
                text("SELECT id FROM approvals WHERE run_id = :r AND step = :s AND action = :t AND status = 'pending'"
                     " ORDER BY created_at DESC LIMIT 1"),
                {"r": ctx.run_id, "s": step, "t": req.action})).scalar()
        if existing is not None:
            approval_id = existing
        else:
            payload_enc = await ctx.crypto(conn).encrypt(ctx.venture_id, PAYLOAD_PURPOSE,
                                                         json.dumps(req.payload, default=str))
            sql = text("INSERT INTO approvals (org_id, venture_id, run_id, step, agent, action, capability, title,"
                       " summary, payload_enc, required_roles, sensitive, status, expires_at)"
                       " VALUES (:o, :v, :r, :s, :a, :t, :c, :ti, :su, :p, :rr, :se, :st,"
                       " CASE WHEN CAST(:exp AS int) IS NULL THEN NULL"
                       "      ELSE now() + make_interval(hours => CAST(:exp AS int)) END)"
                       " RETURNING id")
            params = {"o": ctx.org_id, "v": ctx.venture_id, "r": ctx.run_id, "s": step, "a": req.agent,
                      "t": req.action, "c": cap.value, "ti": req.title[:300], "su": req.summary[:2000],
                      "p": payload_enc, "rr": list(req.required_roles), "se": req.sensitive,
                      "st": "auto_approved" if auto else "pending", "exp": req.expires_in_hours}
            approval_id = None
            if auto:
                # The database has the last word on what may skip a person (private.guard_approval_insert).
                # When it refuses (the option was switched off mid-run, a malformed setting), the draft
                # becomes an ordinary card that waits for a yes instead of failing the run (round 3, B10).
                try:
                    async with conn.begin_nested():
                        approval_id = (await conn.execute(sql, params)).scalar_one()
                except DBAPIError as exc:
                    if getattr(getattr(exc, "orig", None), "sqlstate", None) != "42501" and "42501" not in str(exc):
                        raise
                    auto = False
                    params["st"] = "pending"
                    await security_event("ai.autonomy_withheld", "warning", org_id=ctx.org_id, workflow=ctx.workflow,
                                         action=req.action, reasons="refused by the database guard")
            if approval_id is None:
                approval_id = (await conn.execute(sql, params)).scalar_one()
        if auto:
            state[req.key] = {"status": "auto_approved", "approval_id": str(approval_id), "payload": req.payload,
                              "comment": None}
            if by_option and not trusted:
                await security_event("ai.auto_option_used", "info", org_id=ctx.org_id, workflow=ctx.workflow,
                                     action=req.action, option=req.auto_option)
            elif by_autopilot:
                await security_event("ai.autopilot_used", "info", org_id=ctx.org_id, workflow=ctx.workflow,
                                     action=req.action, agent=req.agent)
        else:
            state[PENDING] = {"approval_id": str(approval_id), "key": req.key, "resume": it.resume,
                              "on_reject": it.on_reject}
            await _write_state(ctx, conn, state,
                               "status = 'waiting', current_step = :s, step_count = :n, lease_owner = NULL,"
                               " lease_until = NULL, reclaims = 0, summary = CAST(:sum AS jsonb)",
                               {"s": it.resume, "n": step_count,
                                "sum": json.dumps(state.get("summary", {}), default=str)})
            await _move_ticket(conn, ctx, "waiting_approval", None)
    if not auto and existing is None:
        # Tell the people who can decide (push, and the business's Slack channel), once the card is
        # committed; never let a notification problem touch the run.
        push.also_slack(ctx.venture_id, title="A draft needs your yes", body=req.title, path=f"/inbox?id={approval_id}")
        # ...and, with buttons, in the Telegram chats and Slack DMs of team members who linked them.
        from kritvia_api.services import chat_approvals
        chat_approvals.announce(ctx.venture_id, approval_id, title=req.title, summary=req.summary,
                                payload=req.payload, sensitive=req.sensitive, agent=req.agent, action=req.action)
        if push.enabled():
            asyncio.get_running_loop().create_task(_notify(approval_id, req.title, ctx.venture_id, req.agent))
    if not auto:
        return None
    return "option" if by_option and not trusted else "trust"


async def _notify(approval_id: uuid.UUID, title: str, venture_id: uuid.UUID, agent: str) -> None:
    try:
        await push.notify_approval(approval_id, title=title, venture_id=venture_id, agent=agent)
    except Exception:  # noqa: BLE001 - best effort by design
        log.exception("push notification failed for approval %s", approval_id)


async def _apply_decision(ctx: RunContext, state: dict) -> str | Finish | None:
    pending = state[PENDING]
    async with ctx.tx("runtime") as conn:
        row = (await conn.execute(
            text("SELECT status, final_payload_enc, comment FROM approvals WHERE id = :id AND run_id = :r"),
            {"id": uuid.UUID(pending["approval_id"]), "r": ctx.run_id})).first()
        if row is None:
            raise RuntimeError("pending approval disappeared")
        if row.status == "pending":
            return None
        payload = None
        if row.final_payload_enc is not None:
            payload = json.loads(await ctx.crypto(conn).decrypt(ctx.venture_id, PAYLOAD_PURPOSE,
                                                                row.final_payload_enc))
    del state[PENDING]
    state[pending["key"]] = {"status": row.status, "approval_id": pending["approval_id"],
                             "payload": payload, "comment": row.comment}
    if row.status in ("approved", "edited"):
        return pending["resume"]
    if pending.get("on_reject"):
        return pending["on_reject"]
    return Finish(outcome=row.status)  # rejected / expired / cancelled


async def cancel_run(user_id: uuid.UUID, run_id: uuid.UUID) -> bool:
    async with tenant_tx(user_id) as conn:
        res = await conn.execute(
            text("UPDATE workflow_runs SET status = 'cancelled', finished_at = now(), updated_at = now(),"
                 " lease_owner = NULL, lease_until = NULL"
                 " WHERE id = :id AND status IN ('queued', 'waiting', 'failed')"), {"id": run_id})
        if res.rowcount == 0:
            return False
        await conn.execute(
            text("UPDATE approvals SET status = 'cancelled' WHERE run_id = :id AND status = 'pending'"),
            {"id": run_id})
        await conn.execute(text("SELECT ticket_for_run(:r, 'cancelled', NULL)"), {"r": run_id})
    return True


async def retry_run(user_id: uuid.UUID, run_id: uuid.UUID, services: Services) -> bool:
    """Re-queue a failed run from the step that failed (its checkpoint is intact), or a run
    parked because its agent's budget was used up."""
    async with tenant_tx(user_id) as conn:
        res = await conn.execute(
            text("UPDATE workflow_runs SET status = 'queued', error = NULL, finished_at = NULL, reclaims = 0,"
                 " summary = summary - 'blocked', updated_at = now()"
                 " WHERE id = :id AND (status = 'failed' OR (status = 'waiting' AND summary ? 'blocked'))"),
            {"id": run_id})
        if res.rowcount == 0:
            return False
        await conn.execute(text("SELECT ticket_for_run(:r, 'open', 'Retried')"), {"r": run_id})
    await services.dispatcher.enqueue_run(run_id)
    return True


async def resume_budget_paused(services: Services, conn=None, venture_id: uuid.UUID | None = None, *,
                               enqueue: bool = True) -> list[uuid.UUID]:
    """Put runs parked by an agent's monthly budget back on the queue once the agent has budget
    again (the owner raised or cleared it, or a new month began). With a connection and venture,
    as that person, for one business; without, for every business (the worker). With
    enqueue=False the caller dispatches the returned runs itself, after its transaction commits."""
    local = services.router.local_deployments()
    sql = text("SELECT run_id FROM private.resume_budget_paused(:l, :v)")
    if conn is not None:
        rows = (await conn.execute(sql, {"l": local, "v": venture_id})).all()
    else:
        async with tenant_tx(None, "system") as c:
            rows = (await c.execute(sql, {"l": local, "v": venture_id})).all()
    ids = [r.run_id for r in rows]
    if enqueue:
        for run_id in ids:
            await services.dispatcher.enqueue_run(run_id)
    if ids:
        log.info("resumed %d budget-paused run(s)", len(ids))
    return ids


async def sweep(services: Services, limit: int = 50) -> int:
    """Re-dispatch queued runs and runs whose worker lease expired. An expired run goes back to 'queued'
    and the attempt is counted; one whose step stopped MAX_RECLAIMS times in a row (it keeps running out
    of time, or the worker keeps dying on it) is failed with a clear message instead of looping forever."""
    async with tenant_tx(None, "system") as conn:
        rows = (await conn.execute(text("SELECT run_id FROM private.reclaim_runs(:l, :m)"),
                                   {"l": limit, "m": MAX_RECLAIMS})).all()
    for r in rows:
        await services.dispatcher.enqueue_run(r.run_id)
    return len(rows)
