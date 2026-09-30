"""Orchestration engine: durability, leases, approvals as interrupts, policy
engine and earned autonomy — tested on a small purpose-built workflow."""
from __future__ import annotations

import asyncio
import uuid

import asyncpg
import pytest

from conftest import ADMIN_DSN, TEST_DB

from kritvia_api.db.session import tenant_tx
from kritvia_api.engine.bootstrap import build_services

from kritvia_api.engine.runner import advance_run, start_run, sweep
from kritvia_api.engine.tools import AlreadyExecuted, PolicyError

pytestmark = pytest.mark.asyncio

from tests_support_flow import EXECUTIONS  # noqa: E402,F401  (registers "test_flow")


async def _start(world, services, **inp):
    return await start_run(services, actor_user_id=world["alice"].id, venture_id=uuid.UUID(world["site"]),
                           workflow="test_flow", input=inp, dispatch=False)


async def _status(run_id):
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        return await conn.fetchrow("SELECT status, current_step, outcome, error, lease_owner FROM workflow_runs"
                                   " WHERE id = $1", run_id)
    finally:
        await conn.close()


async def _pending(run_id):
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        return await conn.fetchval("SELECT id FROM approvals WHERE run_id = $1 AND status = 'pending'", run_id)
    finally:
        await conn.close()


async def _decide(actor, venture, approval_id, **body):
    return await actor.post(f"/ventures/{venture}/approvals/{approval_id}/decision",
                            json={"decision": "approve", **body})


async def test_run_survives_restart_and_resumes_on_approval(world, services):
    run_id = await _start(world, services)
    assert await advance_run(services, run_id) == "waiting"
    assert (await _status(run_id))["lease_owner"] is None

    # "Restart": a brand-new process with new services and a different worker id.
    fresh = build_services(dispatch_mode="inline", router=services.router, sandbox=services.sandbox)
    assert fresh.worker_id != services.worker_id
    approval = await _pending(run_id)
    async with tenant_tx(world["mayank"].id) as conn:
        await conn.execute(__import__("sqlalchemy").text("SELECT decide_approval(:id, 'approved', NULL, NULL)"),
                           {"id": approval})
    assert await advance_run(fresh, run_id) == "completed"
    assert (await _status(run_id))["outcome"] == "sent"


async def test_expired_lease_is_recovered_by_sweeper(world, services):
    run_id = await _start(world, services)
    conn = await asyncpg.connect(ADMIN_DSN)
    try:  # simulate a worker that claimed the run and died
        await conn.execute("UPDATE workflow_runs SET status = 'running', lease_owner = 'dead-worker',"
                           " lease_until = now() - interval '1 minute' WHERE id = $1", run_id)
    finally:
        await conn.close()
    swept = await sweep(services)
    assert swept >= 1
    assert (await _status(run_id))["status"] == "waiting"


async def test_live_lease_blocks_second_worker(world, services):
    run_id = await _start(world, services)
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute("UPDATE workflow_runs SET status = 'running', lease_owner = 'busy-worker',"
                           " lease_until = now() + interval '5 minutes' WHERE id = $1", run_id)
    finally:
        await conn.close()
    assert await advance_run(services, run_id) is None
    assert (await _status(run_id))["lease_owner"] == "busy-worker"


async def test_concurrent_workers_execute_a_run_once(world, services):
    run_id = await _start(world, services)
    other = build_services(dispatch_mode="inline", router=services.router, sandbox=services.sandbox)
    results = await asyncio.gather(advance_run(services, run_id), advance_run(other, run_id))
    assert sorted(r or "" for r in results) == ["", "waiting"]
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        assert await conn.fetchval("SELECT count(*) FROM approvals WHERE run_id = $1", run_id) == 1
    finally:
        await conn.close()


async def test_step_failure_is_visible_and_retryable(world, services):
    run_id = await _start(world, services)
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute("UPDATE workflow_runs SET current_step = 'explode' WHERE id = $1", run_id)
    finally:
        await conn.close()
    assert await advance_run(services, run_id) == "failed"
    st = await _status(run_id)
    assert st["status"] == "failed" and "boom" in st["error"]
    alice, v = world["alice"], world["site"]
    detail = (await alice.get(f"/ventures/{v}/runs/{run_id}")).json()
    assert detail["steps"][-1]["status"] == "failed"
    # fix the step and retry from the checkpoint
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute("UPDATE workflow_runs SET current_step = 'ask' WHERE id = $1", run_id)
    finally:
        await conn.close()
    r = await alice.post(f"/ventures/{v}/runs/{run_id}/retry")
    assert r.status_code == 200 and r.json()["status"] == "waiting"


async def test_step_limit_stops_runaway_loops(world, services):
    run_id = await _start(world, services, loop=True)
    await advance_run(services, run_id)
    for _ in range(40):
        a = await _pending(run_id)
        if a is None:
            break
        async with tenant_tx(world["mayank"].id) as conn:
            await conn.execute(__import__("sqlalchemy").text("SELECT decide_approval(:id, 'approved', NULL, NULL)"),
                               {"id": a})
        if await advance_run(services, run_id) == "failed":
            break
    st = await _status(run_id)
    assert st["status"] == "failed" and "step limit" in st["error"]


# --------------------------------------------------------------- policy engine --
async def test_send_tool_refuses_without_approval_and_executes_once(world, services):
    from kritvia_api.engine.context import RunContext

    run_id = await _start(world, services)
    await advance_run(services, run_id)
    approval = await _pending(run_id)
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        row = await conn.fetchrow("SELECT org_id, venture_id, run_as FROM workflow_runs WHERE id = $1", run_id)
    finally:
        await conn.close()
    ctx = RunContext(run_id=run_id, org_id=row["org_id"], venture_id=row["venture_id"], run_as=row["run_as"],
                     workflow="test_flow", services=services)
    with pytest.raises(PolicyError, match="requires an approval"):
        await ctx.invoke("gmail.send", {"to": "a@b.c", "subject": "x", "body": "y"})
    with pytest.raises(PolicyError, match="pending"):
        await ctx.invoke("gmail.send", approval_id=approval)
    with pytest.raises(PolicyError, match="not 'calendar.create_event'"):
        await ctx.invoke("calendar.create_event", approval_id=approval)

    async with tenant_tx(world["mayank"].id) as c:
        await c.execute(__import__("sqlalchemy").text("SELECT decide_approval(:id, 'approved', NULL, NULL)"),
                        {"id": approval})
    other = RunContext(run_id=uuid.uuid4(), org_id=row["org_id"], venture_id=row["venture_id"], run_as=row["run_as"],
                       workflow="test_flow", services=services)
    with pytest.raises(PolicyError, match="does not belong"):
        await other.invoke("gmail.send", approval_id=approval)
    first = await ctx.invoke("gmail.send", approval_id=approval)
    assert first["status"] == "logged"
    with pytest.raises(AlreadyExecuted):
        await ctx.invoke("gmail.send", approval_id=approval)


async def test_database_refuses_forged_decisions(world, services):
    run_id = await _start(world, services)
    await advance_run(services, run_id)
    approval = await _pending(run_id)
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        run_as = await conn.fetchval("SELECT run_as FROM workflow_runs WHERE id = $1", run_id)
    finally:
        await conn.close()
    app = await asyncpg.connect(f"postgresql://kritvia_app:app@localhost/{TEST_DB}")
    try:
        # the agent itself cannot approve its own draft
        async with app.transaction():
            await app.execute("SELECT set_config('app.user_id', $1, true)", str(run_as))
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await app.execute("SELECT decide_approval($1, 'approved', NULL, NULL)", approval)
        # nor flip the status column directly
        async with app.transaction():
            await app.execute("SELECT set_config('app.user_id', $1, true)", str(run_as))
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await app.execute("UPDATE approvals SET status = 'approved' WHERE id = $1", approval)
        # nor create an auto-approved draft for an action that never earned it
        async with app.transaction():
            await app.execute("SELECT set_config('app.user_id', $1, true)", str(run_as))
            row = await app.fetchrow("SELECT org_id, venture_id, payload_enc FROM approvals WHERE id = $1", approval)
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await app.execute(
                    "INSERT INTO approvals (org_id, venture_id, run_id, step, agent, action, capability, title,"
                    " payload_enc, status) VALUES ($1, $2, $3, 'x', 'mailer', 'gmail.send', 'send', 't', $4,"
                    " 'auto_approved')", row["org_id"], row["venture_id"], run_id, row["payload_enc"])
        # a viewer cannot decide
        async with app.transaction():
            await app.execute("SELECT set_config('app.user_id', $1, true)", str(world["vera"].id))
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await app.execute("SELECT decide_approval($1, 'approved', NULL, NULL)", approval)
    finally:
        await app.close()


async def test_double_decision_is_a_conflict(world, services):
    run_id = await _start(world, services)
    await advance_run(services, run_id)
    approval = await _pending(run_id)
    mayank, v = world["mayank"], world["site"]
    assert (await _decide(mayank, v, approval)).status_code == 200
    r = await _decide(mayank, v, approval)
    assert r.status_code == 409 and "already" in r.json()["detail"]


async def test_edit_validation(world, services):
    run_id = await _start(world, services)
    await advance_run(services, run_id)
    approval = await _pending(run_id)
    mayank, v = world["mayank"], world["site"]
    r = await _decide(mayank, v, approval, edited_payload={"bcc": "spy@evil.com"})
    assert r.status_code == 422
    r = await _decide(mayank, v, approval, edited_payload={"to": "not-an-email"})
    assert r.status_code == 422
    r = await _decide(mayank, v, approval, edited_payload={"body": ["not", "a", "string"]})
    assert r.status_code == 422


# ------------------------------------------------------------ earned autonomy --
async def test_earned_autonomy_promotion_and_auto_run(world, services):
    mayank, v = world["mayank"], world["site"]
    # set a low threshold for the test
    assert (await mayank.put(f"/ventures/{v}/settings", json={"trust_threshold": 5})).status_code == 200
    # earlier tests may have recorded history; make it clean and short of the threshold
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute(
            "INSERT INTO agent_trust (org_id, venture_id, agent, action, consecutive_clean, approved_clean)"
            " VALUES ($1, $2, 'mailer', 'gmail.send', 3, 3) ON CONFLICT (venture_id, agent, action)"
            " DO UPDATE SET consecutive_clean = 3, auto_run = false", uuid.UUID(world["org"]), uuid.UUID(v))
    finally:
        await conn.close()
    r = await mayank.post(f"/ventures/{v}/trust/mailer/gmail.send", json={"auto_run": True, "reason": "try"})
    assert r.status_code == 409 and "needs 5" in r.json()["detail"]
    # Alice (operator) can never promote
    r = await world["alice"].post(f"/ventures/{v}/trust/mailer/gmail.send", json={"auto_run": True, "reason": "mine"})
    assert r.status_code == 404

    for _ in range(2):
        run_id = await _start(world, services)
        await advance_run(services, run_id)
        assert (await _decide(mayank, v, await _pending(run_id))).status_code == 200
    r = await mayank.post(f"/ventures/{v}/trust/mailer/gmail.send", json={"auto_run": True, "reason": "earned"})
    assert r.status_code == 200
    row = [t for t in r.json() if t["agent"] == "mailer"][0]
    assert row["auto_run"] and row["eligible"]

    run_id = await _start(world, services)
    assert await advance_run(services, run_id) == "completed"   # no human in the loop
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        a = await conn.fetchrow("SELECT status, executed_at FROM approvals WHERE run_id = $1", run_id)
        t = await conn.fetchrow("SELECT auto_executed FROM agent_trust WHERE venture_id = $1 AND agent = 'mailer'",
                                uuid.UUID(v))
        promoted = await conn.fetchval("SELECT count(*) FROM audit_log WHERE action = 'autonomy.promoted'"
                                       " AND venture_id = $1", uuid.UUID(v))
    finally:
        await conn.close()
    assert a["status"] == "auto_approved" and a["executed_at"] is not None
    assert t["auto_executed"] >= 1 and promoted >= 1

    # demotion puts the human back in the loop immediately
    r = await mayank.post(f"/ventures/{v}/trust/mailer/gmail.send", json={"auto_run": False, "reason": "bad send"})
    assert r.status_code == 200
    run_id = await _start(world, services)
    assert await advance_run(services, run_id) == "waiting"
