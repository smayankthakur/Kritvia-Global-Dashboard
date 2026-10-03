"""The board: tickets follow runs, roles carry spend and budgets, a used-up budget parks
the agent (never drops the message) and a retry resumes it."""
from __future__ import annotations

import uuid

import asyncpg
import pytest

from conftest import ADMIN_DSN, join, make_actor
from test_inbox_assistant import SUPPORT_MAIL, script_inbox

pytestmark = pytest.mark.asyncio


@pytest.fixture(scope="module")
async def desk(world, client):
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Desk", "slug": f"desk-{uuid.uuid4().hex[:6]}"})).json()["id"]
    await mayank.put(f"/ventures/{v}/settings", json={"kind": "general", "business_name": "Desk Co", "city": "Delhi"})
    assert (await mayank.put(f"/ventures/{v}/workflow-configs/inbox_assistant",
                             json={"enabled": True, "settings": {}})).status_code == 200
    approver = await make_actor(client, "desk-approver")
    await join(mayank, approver, world["org"], v, "approver")
    return {**world, "desk": v, "approver": approver}


async def test_ticket_follows_the_run_and_roles_default(desk, fake_llm):
    mayank, approver, v = desk["mayank"], desk["approver"], desk["desk"]
    script_inbox(fake_llm)
    r = await mayank.post(f"/ventures/{v}/runs", json={"workflow": "inbox_assistant", "input": SUPPORT_MAIL})
    assert r.status_code == 201, r.text
    run_id = r.json()["id"]

    b = (await mayank.get(f"/ventures/{v}/board")).json()
    front = next(x for x in b["roles"] if x["workflow"] == "inbox_assistant")
    assert front["role"] == "front_desk" and front["role_title"] == "Front desk" and front["monthly_tokens"] is None
    assert front["used_tokens"] > 0 and front["waiting"] == 1 and front["paused"] is False
    card = next(t for t in b["tickets"] if t["run_id"] == run_id)
    assert card["status"] == "waiting_approval" and card["role"] == "front_desk" and card["pending_approval_id"]
    assert b["budgets_editable"] is True and b["month_tokens"] >= front["used_tokens"]

    d = await approver.post(f"/ventures/{v}/approvals/{card['pending_approval_id']}/decision", json={"decision": "approve"})
    assert d.status_code == 200, d.text
    b = (await mayank.get(f"/ventures/{v}/board")).json()
    card = next(t for t in b["tickets"] if t["run_id"] == run_id)
    assert card["status"] == "done" and card["note"] == "replied" and card["finished_at"]

    # the mission sits at the top; an operator cannot write it
    m = await mayank.put(f"/ventures/{v}/board/mission", json={"title": "Reply to every enquiry within an hour"})
    assert m.status_code == 200 and m.json()["title"].startswith("Reply")
    assert (await mayank.get(f"/ventures/{v}/board")).json()["mission"]["title"].startswith("Reply")
    # every agent reads the mission on its next run
    script_inbox(fake_llm)
    await mayank.post(f"/ventures/{v}/runs", json={"workflow": "inbox_assistant", "input": SUPPORT_MAIL})
    assert any("mission for the whole team: Reply to every enquiry" in c["prompt"]
               for c in fake_llm.chat_calls("You answer the business's"))
    assert (await approver.put(f"/ventures/{v}/board/mission", json={"title": "x"})).status_code == 404
    # another organisation sees nothing
    assert (await desk["mallory"].get(f"/ventures/{v}/board")).status_code == 404


async def test_budget_parks_the_agent_and_retry_resumes(desk, fake_llm, services):
    mayank, v = desk["mayank"], desk["desk"]
    # move the agent and give it a budget smaller than what it has already used this month
    r = await mayank.put(f"/ventures/{v}/board/agents/inbox_assistant", json={"role": "ops", "monthly_tokens": 1})
    assert r.status_code == 200, r.text
    assert r.json()["role"] == "ops" and r.json()["monthly_tokens"] == 1 and r.json()["paused"] is True

    script_inbox(fake_llm)
    run_id = (await mayank.post(f"/ventures/{v}/runs", json={"workflow": "inbox_assistant",
                                                             "input": SUPPORT_MAIL})).json()["id"]
    run = (await mayank.get(f"/ventures/{v}/runs/{run_id}")).json()
    assert run["status"] == "waiting" and run["summary"].get("blocked") == "budget" and run["error"] is None
    card = next(t for t in (await mayank.get(f"/ventures/{v}/board")).json()["tickets"] if t["run_id"] == run_id)
    assert card["status"] == "blocked" and "budget" in card["note"]
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        blocked = await conn.fetchval("SELECT count(*) FROM model_calls WHERE venture_id = $1 AND status = 'blocked'"
                                      " AND error = 'agent budget used'", uuid.UUID(v))
        attributed = await conn.fetchval("SELECT count(*) FROM model_calls WHERE venture_id = $1 AND status = 'ok'"
                                         " AND agent_id IS NOT NULL AND ticket_id IS NOT NULL", uuid.UUID(v))
    finally:
        await conn.close()
    assert blocked >= 1 and attributed >= 1

    # lifting the budget and retrying picks the run up where it stopped
    assert (await mayank.put(f"/ventures/{v}/board/agents/inbox_assistant", json={"clear_budget": True})).json()["paused"] is False
    assert (await mayank.post(f"/ventures/{v}/runs/{run_id}/retry")).status_code == 200
    run = (await mayank.get(f"/ventures/{v}/runs/{run_id}")).json()
    assert run["status"] == "waiting" and "blocked" not in run["summary"] and run["current_step"] == "send"
    card = next(t for t in (await mayank.get(f"/ventures/{v}/board")).json()["tickets"] if t["run_id"] == run_id)
    assert card["status"] == "waiting_approval"


async def test_free_plan_cannot_set_budgets(client, monkeypatch):
    from kritvia_api.config import get_settings
    monkeypatch.setattr(get_settings(), "default_plan", "free")
    owner = await make_actor(client, "freeboard")
    org = (await owner.post("/orgs", json={"name": "Free Board", "slug": "fb-" + uuid.uuid4().hex[:8]})).json()["id"]
    v = (await owner.post(f"/orgs/{org}/ventures", json={"name": "One", "slug": "one"})).json()["id"]
    assert (await owner.get(f"/ventures/{v}/board")).json()["budgets_editable"] is False
    r = await owner.put(f"/ventures/{v}/board/agents/inbox_assistant", json={"monthly_tokens": 1000})
    assert r.status_code == 402
    assert (await owner.put(f"/ventures/{v}/board/agents/inbox_assistant", json={"role": "sales"})).status_code == 200
