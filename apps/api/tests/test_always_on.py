"""Always on (patch 0094): runs that fail for a passing reason retry by themselves; workers' heartbeats and the
queue show on /livez; the in-app watchdog heals the queue and tells Kritvia's team once, then on recovery."""
from __future__ import annotations

import asyncio

import asyncpg
import httpx
import pytest
from sqlalchemy.exc import DBAPIError

from conftest import ADMIN_DSN
from kritvia_api.engine.runner import advance_run, passing
from kritvia_api.engine.tools import PolicyError
from kritvia_api.services import watchdog
from kritvia_api.services.mailer import get_mailer
from kritvia_api.services.model_router import AllProvidersFailed
from test_engine import _start, _status
from tests_support_flow import FLAKY

pytestmark = pytest.mark.asyncio


async def sql(q: str, *args):
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        return await conn.fetch(q, *args)
    finally:
        await conn.close()


def test_which_failures_pass_by_themselves():
    assert passing(httpx.ConnectTimeout("x")) and passing(asyncio.TimeoutError())
    assert passing(AllProvidersFailed("every provider failed", []))
    assert passing(RuntimeError("POST https://gmail.googleapis.com/... -> HTTP 503"))
    assert passing(RuntimeError("HTTP 429 too many requests"))
    assert not passing(ValueError("bad input")) and not passing(PolicyError("no approval"))
    assert not passing(RuntimeError("boom")) and not passing(RuntimeError("HTTP 404 not found"))

    class Orig:
        sqlstate = "40P01"
    e = DBAPIError("UPDATE …", {}, Orig())
    assert passing(e)


async def test_a_run_that_times_out_tries_again_later_and_then_carries_on(world, services):
    run_id = await _start(world, services)
    await sql("UPDATE workflow_runs SET current_step = 'flaky' WHERE id = $1", run_id)
    FLAKY["left"] = 1
    assert await advance_run(services, run_id) == "retrying"
    row = (await sql("SELECT status, retries, next_retry_at > now() AS later, error FROM workflow_runs WHERE id = $1",
                     run_id))[0]
    assert row["status"] == "queued" and row["retries"] == 1 and row["later"] and "timed out" in row["error"]
    # not picked up before its time
    ready = await sql("SELECT run_id FROM private.runnable_runs(1000)")
    assert run_id not in {r["run_id"] for r in ready}
    await sql("UPDATE workflow_runs SET next_retry_at = now() - interval '1 second' WHERE id = $1", run_id)
    assert run_id in {r["run_id"] for r in await sql("SELECT run_id FROM private.runnable_runs(1000)")}
    assert await advance_run(services, run_id) == "waiting"        # carried on to the approval
    # three passing failures in a row: then it stays failed, as before
    run2 = await _start(world, services)
    await sql("UPDATE workflow_runs SET current_step = 'flaky' WHERE id = $1", run2)
    FLAKY["left"] = 10
    for _ in range(3):
        assert await advance_run(services, run2) == "retrying"
        await sql("UPDATE workflow_runs SET next_retry_at = now() WHERE id = $1", run2)
    assert await advance_run(services, run2) == "failed"
    assert (await _status(run2))["status"] == "failed"
    FLAKY["left"] = 0


async def test_livez_and_the_watchdog(client, services, monkeypatch):
    await watchdog.heartbeat("worker", "w-test")
    r = await client.get("/livez")
    body = r.json()
    assert body["worker_age_s"] is not None and body["worker_age_s"] < 5 and "queued" in body
    # a quiet worker makes /livez answer 503
    await sql("UPDATE system_heartbeats SET beat_at = now() - interval '10 minutes' WHERE name = 'worker'")
    assert (await client.get("/livez")).status_code == 503
    await watchdog.heartbeat("worker", "w-test")

    # problems are told to Kritvia's team once, then again only on recovery
    from kritvia_api.config import get_settings
    monkeypatch.setattr(get_settings(), "staff_emails", "team@kritvia.test")
    fake = {"queued": 3, "oldest_queued_s": 900, "stuck": 0, "retrying": 0, "failed_15m": 0, "ai_calls_15m": 10,
            "ai_failed_15m": 9, "worker_age_s": 3, "priority_age_s": None, "ok": False}
    state = {"st": fake}

    async def status(conn):
        return state["st"]
    monkeypatch.setattr(watchdog, "status", status)
    await sql("DELETE FROM platform_alerts")
    out = get_mailer().outbox
    before = len(out)
    found = await watchdog.check(services)
    assert set(found) == {"backlog", "ai"}
    sent = [m for m in out[before:] if m["To"] == "team@kritvia.test"]
    assert {m["Subject"] for m in sent} == {"Kritvia: Runs are waiting to start", "Kritvia: AI calls are failing"}
    await watchdog.check(services)                       # still failing: not again within the hour
    assert len([m for m in out[before:] if m["To"] == "team@kritvia.test"]) == 2
    state["st"] = {**fake, "oldest_queued_s": 0, "ai_failed_15m": 0}
    assert await watchdog.check(services) == {}
    recovered = [m["Subject"] for m in out[before:] if m["To"] == "team@kritvia.test"][2:]
    assert sorted(recovered) == ["Kritvia recovered: AI calls are failing", "Kritvia recovered: Runs are waiting to start"]
