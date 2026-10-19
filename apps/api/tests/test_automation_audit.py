"""The automation audit: every business job's level is backed by the code, every agent and tool is
classified, nothing regresses, and agents that look on can actually run. Plus a business's live health."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import asyncpg
import pytest

from conftest import ADMIN_DSN, join, make_actor
from kritvia_api.automation_audit import audit
from kritvia_api.automation_audit.catalogue import JOBS, Job
from kritvia_api.engine.core import registry

IST = timezone(timedelta(hours=5, minutes=30))


@pytest.fixture(scope="module")
def report():
    return audit.run()


def test_every_job_is_backed_by_the_code(report):
    bad = {j["key"]: j["problems"] for j in report["jobs"] if j["problems"]}
    assert not bad, bad
    unresolved = [e["ref"] for c in report["platform"] for e in c["evidence"] if e["ok"] is False]
    assert not unresolved, unresolved


def test_every_agent_and_tool_is_classified(report):
    # a new agent or tool must be added to a job in automation_audit/catalogue.py
    assert report["unclassified"] == {"workflows": [], "tools": []}, report["unclassified"]


def test_no_job_drops_below_its_baseline(report):
    # raising a level is welcome: run `python -m kritvia_api.automation_audit --write-baseline` to keep it
    assert not audit.regressions(report), audit.regressions(report)


def test_agents_that_look_on_can_run(report):
    assert not report["integrity"], report["integrity"]
    clock = {w.name for w in registry.all() if w.starts == "clock"}
    assert clock == {"prospector", "collections", "kitchen_daily", "trade_watch", "whatsapp_followup", "reviews",
                     "booking_reminders"}
    assert {w.name for w in registry.all() if w.starts == "request"} == {"assistant", "browser", "voice_call",
                                                                          "trade_update"}


def test_levels_must_be_earned():
    ix = audit.Index.build()
    # an agent only a person can start is not "autopilot"
    fake = Job("x", "sales", "X", 3, "x", ("wf:voice_call",), next="x")
    assert any("starts by itself" in p for p in audit.job_problems(fake, ix, [audit.resolve(r, ix) for r in fake.evidence]))
    # pointers that don't resolve are caught
    ghost = Job("y", "sales", "Y", 2, "y", ("wf:nope", "tool:nope.send", "route:GET /nope", "cron:nope"), next="y")
    probs = audit.job_problems(ghost, ix, [audit.resolve(r, ix) for r in ghost.evidence])
    assert sum("no such" in p for p in probs) == 4
    # a job above its ceiling, or claiming level 0 with code, is refused
    assert audit.job_problems(Job("z", "sales", "Z", 4, "z", ("cron:sweep",), ceiling=3, target=3), ix, [])
    assert audit.job_problems(Job("w", "sales", "W", 0, "w", ("cron:sweep",), target=0), ix, [])


def test_scorecard_shape(report):
    s = report["summary"]
    assert s["jobs"] == len(JOBS) and 0 < s["autonomy"] <= s["target"] <= 100
    assert sum(s["levels"].values()) == len(JOBS)
    assert report["roadmap"] and all(r["to"] > r["from"] and r["next"] for r in report["roadmap"])
    assert "| Sales and leads |" in audit.markdown(report)


# ------------------------------------------------------------------ the API --
@pytest.fixture
async def biz(world, client):
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Audit Shop", "slug": f"audit-{uuid.uuid4().hex[:6]}"})).json()["id"]
    operator = await make_actor(client, "audit-operator")
    await join(mayank, operator, world["org"], v, "operator")
    return {**world, "v": v, "operator": operator}


async def test_clock_agents_always_get_a_time_and_only_they_can(biz):
    mayank, v = biz["mayank"], biz["v"]
    cat = {w["name"]: w for w in (await mayank.get("/workflows")).json()}
    assert cat["collections"]["starts"] == "clock" and cat["collections"]["default_schedule"] == "10:00"
    assert cat["inbox_assistant"]["starts"] == "event" and cat["inbox_assistant"]["default_schedule"] is None
    # switched on without a time: it gets its usual one instead of never running
    r = await mayank.put(f"/ventures/{v}/workflow-configs/collections", json={"enabled": True})
    assert r.status_code == 200 and r.json()["schedule"] == "10:00"
    r = await mayank.put(f"/ventures/{v}/workflow-configs/collections", json={"enabled": True, "schedule": "08:15"})
    assert r.json()["schedule"] == "08:15"
    # an agent that starts on messages has nothing to do at a set time
    r = await mayank.put(f"/ventures/{v}/workflow-configs/inbox_assistant", json={"enabled": True, "schedule": "09:00"})
    assert r.status_code == 422 and "doesn't run at a set time" in r.text
    assert (await mayank.put(f"/ventures/{v}/workflow-configs/inbox_assistant", json={"enabled": True})).json()[
        "schedule"] is None


async def test_starter_kits_give_clock_agents_their_time(biz):
    mayank, v = biz["mayank"], biz["v"]
    # an agent already on without a time (as kits used to leave them) is given one too
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        org = await conn.fetchval("SELECT org_id FROM ventures WHERE id = $1", uuid.UUID(v))
        await conn.execute("INSERT INTO workflow_configs (org_id, venture_id, workflow, enabled) VALUES ($1, $2, 'reviews', true)",
                           org, uuid.UUID(v))
    finally:
        await conn.close()
    r = await mayank.post(f"/ventures/{v}/templates/clinic/apply")
    assert r.status_code == 200, r.text
    configs = {c["workflow"]: c for c in (await mayank.get(f"/ventures/{v}/workflow-configs")).json()}
    clock_on = [w for w, c in configs.items() if c["enabled"] and registry.get(w).starts == "clock"]
    assert clock_on and all(configs[w]["schedule"] == registry.get(w).default_schedule for w in clock_on), configs
    assert configs["reviews"]["schedule"] == "19:00"


async def test_the_clock_never_starts_an_event_agent(biz, services):
    from kritvia_worker.main import fire_schedules
    mayank, v = biz["mayank"], biz["v"]
    conn = await asyncpg.connect(ADMIN_DSN)
    try:     # an old row from before the rule: the inbox assistant with a daily time
        org = await conn.fetchval("SELECT org_id FROM ventures WHERE id = $1", uuid.UUID(v))
        await conn.execute("INSERT INTO workflow_configs (org_id, venture_id, workflow, enabled, schedule)"
                           " VALUES ($1, $2, 'inbox_assistant', true, '04:41')", org, uuid.UUID(v))
    finally:
        await conn.close()
    await fire_schedules({"services": services}, datetime(2026, 10, 2, 4, 41, tzinfo=IST))
    assert (await mayank.get(f"/ventures/{v}/runs?workflow=inbox_assistant")).json() == []


async def test_live_health_shows_what_ran_and_what_is_stuck(biz):
    mayank, operator, v = biz["mayank"], biz["operator"], biz["v"]
    assert (await operator.get(f"/ventures/{v}/automation-health")).status_code == 404
    conn = await asyncpg.connect(ADMIN_DSN)
    try:     # on, but no time: what starter kits used to leave behind
        org = await conn.fetchval("SELECT org_id FROM ventures WHERE id = $1", uuid.UUID(v))
        await conn.execute("INSERT INTO workflow_configs (org_id, venture_id, workflow, enabled) VALUES ($1, $2, 'booking_reminders', true)",
                           org, uuid.UUID(v))
        await conn.execute("INSERT INTO workflow_configs (org_id, venture_id, workflow, enabled) VALUES ($1, $2, 'inbox_assistant', true)",
                           org, uuid.UUID(v))
    finally:
        await conn.close()
    r = await mayank.get(f"/ventures/{v}/automation-health?days=7")
    assert r.status_code == 200, r.text
    h = r.json()
    agents = {a["workflow"]: a for a in h["agents"]}
    assert agents["booking_reminders"]["state"] == "on_no_time"
    assert agents["inbox_assistant"]["state"] == "on_no_source"        # nothing connected feeds it
    assert agents["collections"]["state"] == "off"
    assert h["summary"]["agents_on_but_stuck"] == 2
    texts = " ".join(f["text"] for f in h["findings"])
    assert "no time set" in texts and "nothing feeds it" in texts
    assert set(h["summary"]) >= {"runs", "sent_by_itself", "approved_by_a_person", "expired", "calls_answered"}

    # an agent that runs with nothing to work with, and a draft that expired waiting for a yes
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute("UPDATE workflow_configs SET schedule = '18:00' WHERE venture_id = $1 AND workflow = 'booking_reminders'",
                           uuid.UUID(v))
        await conn.execute("INSERT INTO workflow_configs (org_id, venture_id, workflow, enabled, schedule)"
                           " VALUES ($1, $2, 'whatsapp_followup', true, '11:00')", org, uuid.UUID(v))
        await conn.execute("INSERT INTO workflow_runs (org_id, venture_id, workflow, status, outcome, trigger_kind,"
                           " current_step, run_as) VALUES ($1, $2, 'whatsapp_followup', 'completed', 'no_template',"
                           " 'schedule', 'route', $3)", org, uuid.UUID(v), mayank.id)
    finally:
        await conn.close()
    h = (await mayank.get(f"/ventures/{v}/automation-health")).json()
    agents = {a["workflow"]: a for a in h["agents"]}
    assert agents["booking_reminders"]["state"] == "ready"
    assert agents["whatsapp_followup"]["outcomes"] == {"no_template": 1}
    assert any("choose a WhatsApp template" in f["text"] for f in h["findings"])


async def test_scorecard_endpoint(biz):
    r = await biz["mayank"].get("/automation/scorecard")
    assert r.status_code == 200 and r.json()["summary"]["jobs"] == len(JOBS)
