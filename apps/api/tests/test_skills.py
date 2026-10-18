"""Skills: a job in plain words becomes a saved skill; it runs on demand, on a schedule, or once per record
when something happens (here: an overdue invoice); edits and notes on its drafts become lessons later
runs follow; "Save as a skill" turns a request that worked into one; and the usual roles apply."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import asyncpg
import pytest

from conftest import ADMIN_DSN, join, make_actor
from kritvia_api.services import skills as sk
from test_invoices import invoice, today

MARK = "You are the business's assistant"
UNDERSTAND = "You turn a person's words into a repeatable job"
LEARN = "You learn a small business's preferences"


@pytest.fixture
async def shop(world, client):
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Skill Shop", "slug": f"skill-{uuid.uuid4().hex[:6]}"})).json()["id"]
    await mayank.put(f"/ventures/{v}/settings", json={"kind": "general", "business_name": "Skill Shop", "city": "Delhi"})
    operator = await make_actor(client, "skill-operator")
    await join(mayank, operator, world["org"], v, "operator")
    approver = await make_actor(client, "skill-approver")
    await join(mayank, approver, world["org"], v, "approver")
    return {**world, "v": v, "operator": operator, "approver": approver}


def planner(fake_llm, *steps):
    calls = {"n": 0, "prompts": []}

    def reply(messages):
        calls["prompts"].append(messages[-1]["content"])
        i = min(calls["n"], len(steps) - 1)
        calls["n"] += 1
        s = steps[i]
        return s(messages) if callable(s) else s
    fake_llm.on(MARK, reply)
    return calls


async def make(actor, v, **kw) -> dict:
    body = {"name": "Thank-you note", "instructions": "1. Email the customer a short thank-you.", "trigger": "manual", **kw}
    r = await actor.post(f"/ventures/{v}/skills", json=body)
    assert r.status_code == 201, r.text
    return r.json()


async def test_plain_words_become_a_draft_with_its_trigger(shop, fake_llm):
    mayank, v = shop["mayank"], shop["v"]
    fake_llm.on(UNDERSTAND, {"name": "Overdue reminders", "trigger": "event", "event": "invoice_overdue", "wait_days": 7,
                             "at_time": "10:00", "instructions": "1. WhatsApp the customer a polite reminder.\n2. Add a task for Ravi."})
    r = await mayank.post(f"/ventures/{v}/skills/understand",
                          json={"words": "Jab invoice 7 din overdue ho, customer ko reminder bhejo aur Ravi ke liye task banao"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["trigger"] == "event" and d["event"] == "invoice_overdue" and d["wait_days"] == 7
    assert d["when"] == "An invoice is 7 day(s) overdue (checked daily at 10:00)"
    # nothing was saved
    assert (await mayank.get(f"/ventures/{v}/skills")).json() == []
    # a draft the model gets half right is made consistent (schedule without a time -> 09:00; weekly needs a day)
    fake = sk.clean(sk.Draft(name=" Weekly  report ", instructions="1. Send me the numbers.", trigger="schedule", freq="weekly"))
    assert (fake.name, fake.at_time, fake.weekdays) == ("Weekly report", "09:00", [0])
    with pytest.raises(ValueError):
        sk.clean(sk.Draft(name="x", instructions="1. do it", trigger="event"))


async def test_a_skill_runs_through_the_assistant_and_learns_from_edits_and_notes(shop, fake_llm):
    mayank, v = shop["mayank"], shop["v"]
    s = await make(mayank, v)
    assert s["when"] == "When you run it" and s["lessons"] == [] and s["can_edit"]
    p = planner(fake_llm, {"tool": "gmail.send", "title": "Thank-you to Priya",
                           "args": {"to": "priya@example.com", "subject": "Thank you", "body": "Hi Priya, thanks!"}},
                {"answer": "Sent."})
    fake_llm.on(LEARN, {"lesson": "Greet customers with 'Namaste' and sign off as Team Skill Shop."})
    run = (await mayank.post(f"/ventures/{v}/skills/{s['id']}/run")).json()["run_id"]
    assert 'Do the job "Thank-you note"' in p["prompts"][0] and "Email the customer a short thank-you" in p["prompts"][0]
    item = (await mayank.get(f"/ventures/{v}/assistant/{run}")).json()
    assert item["skill_id"] == s["id"] and item["status"] == "waiting"
    # the person edits the draft: the skill learns
    d = await mayank.post(f"/ventures/{v}/approvals/{item['pending_approval_id']}/decision", json={
        "decision": "approve", "edited_payload": {"to": "priya@example.com", "subject": "Thank you",
                                                  "body": "Namaste Priya ji, thank you! Team Skill Shop"}})
    assert d.status_code == 200, d.text
    got = next(x for x in (await mayank.get(f"/ventures/{v}/skills")).json() if x["id"] == s["id"])
    assert got["lessons"] == ["Greet customers with 'Namaste' and sign off as Team Skill Shop."] and got["lessons_learned"] == 1
    assert got["runs"] == 1
    learn = fake_llm.chat_calls(LEARN)[-1]["prompt"]
    assert "Hi Priya, thanks!" in learn and "Namaste Priya ji" in learn

    # the next run is told the lesson; a note on a rejected draft becomes a lesson too
    p = planner(fake_llm, {"tool": "gmail.send", "args": {"to": "a@example.com", "subject": "x", "body": "y 10% off"}},
                {"answer": "Okay."})
    fake_llm.on(LEARN, {"lesson": "Never offer a discount."})
    run = (await mayank.post(f"/ventures/{v}/skills/{s['id']}/run")).json()["run_id"]
    assert "Lessons from earlier runs" in p["prompts"][0] and "Namaste" in p["prompts"][0]
    item = (await mayank.get(f"/ventures/{v}/assistant/{run}")).json()
    await mayank.post(f"/ventures/{v}/approvals/{item['pending_approval_id']}/decision",
                      json={"decision": "reject", "comment": "No discounts, ever"})
    got = next(x for x in (await mayank.get(f"/ventures/{v}/skills")).json() if x["id"] == s["id"])
    assert got["lessons"][-1] == "Never offer a discount." and got["lessons_learned"] == 2
    # a lesson can be forgotten
    r = await mayank.delete(f"/ventures/{v}/skills/{s['id']}/lessons/0")
    assert r.status_code == 200 and r.json()["lessons"] == ["Never offer a discount."]
    assert len((await mayank.get(f"/ventures/{v}/skills/{s['id']}/runs")).json()) == 2


async def test_an_event_skill_runs_once_per_overdue_invoice(shop, fake_llm, services):
    mayank, operator, v = shop["mayank"], shop["operator"], shop["v"]
    r = await operator.post(f"/ventures/{v}/invoices", json=invoice(
        number="SK-1", issued_on=str(today() - timedelta(days=30)), due_on=str(today() - timedelta(days=9))))
    assert r.status_code == 201, r.text
    s = await make(mayank, v, name="Overdue nudge", instructions="1. Draft a polite reminder.", trigger="event",
                   event="invoice_overdue", wait_days=7, at_time="10:00")
    assert s["next_run_at"] and s["when"].startswith("An invoice is 7 day(s) overdue")
    p = planner(fake_llm, {"answer": "Drafted."})
    admin = await asyncpg.connect(ADMIN_DSN)
    try:
        await admin.execute("UPDATE skills SET next_run_at = now() - interval '1 minute' WHERE id = $1", uuid.UUID(s["id"]))
        assert await sk.fire_due(services) == 1
        assert "This run is about" in p["prompts"][-1] and "Neha Traders" in p["prompts"][-1]
        nxt = await admin.fetchval("SELECT next_run_at FROM skills WHERE id = $1", uuid.UUID(s["id"]))
        assert nxt > datetime.now(UTC)
        # the next daily check doesn't start the same invoice again
        await admin.execute("UPDATE skills SET next_run_at = now() - interval '1 minute' WHERE id = $1", uuid.UUID(s["id"]))
        assert await sk.fire_due(services) == 0
    finally:
        await admin.close()
    runs = (await mayank.get(f"/ventures/{v}/skills/{s['id']}/runs")).json()
    assert len(runs) == 1


async def test_a_scheduled_skill_runs_and_moves_to_its_next_time(shop, fake_llm, services):
    mayank, v = shop["mayank"], shop["v"]
    s = await make(mayank, v, name="Monday plan", instructions="1. List this week's open tasks.", trigger="schedule",
                   freq="weekly", weekdays=[0], at_time="09:00")
    assert s["when"] == "Every Monday at 09:00"
    planner(fake_llm, {"answer": "Plan sent."})
    admin = await asyncpg.connect(ADMIN_DSN)
    try:
        await admin.execute("UPDATE skills SET next_run_at = now() - interval '1 minute' WHERE id = $1", uuid.UUID(s["id"]))
        assert await sk.fire_due(services) == 1
        nxt = await admin.fetchval("SELECT next_run_at FROM skills WHERE id = $1", uuid.UUID(s["id"]))
    finally:
        await admin.close()
    assert nxt.astimezone(sk.ZoneInfo("Asia/Kolkata")).weekday() == 0
    # switched off: nothing is due
    body = {k: s[k] for k in ("name", "instructions", "trigger", "freq", "weekdays", "at_time")} | {"enabled": False}
    r = await mayank.put(f"/ventures/{v}/skills/{s['id']}", json=body)
    assert r.status_code == 200 and r.json()["enabled"] is False and r.json()["next_run_at"] is None


async def test_save_a_request_that_worked_as_a_skill(shop, fake_llm):
    mayank, operator, v = shop["mayank"], shop["operator"], shop["v"]
    planner(fake_llm, {"answer": "Done."})
    item = (await mayank.post(f"/ventures/{v}/assistant", json={"request": "Send Priya the proposal follow-up"})).json()
    fake_llm.on(UNDERSTAND, {"name": "Proposal follow-up", "instructions": "1. Find the lead.\n2. Draft a follow-up email.",
                             "trigger": "manual"})
    r = await mayank.post(f"/ventures/{v}/skills/from-request", json={"run_id": item["run_id"]})
    assert r.status_code == 200 and r.json()["name"] == "Proposal follow-up"
    assert "Send Priya the proposal follow-up" in fake_llm.chat_calls(UNDERSTAND)[-1]["prompt"]
    # someone else's request can't be read this way
    assert (await operator.post(f"/ventures/{v}/skills/from-request", json={"run_id": item["run_id"]})).status_code == 404
    saved = await make(mayank, v, name="Proposal follow-up", instructions=r.json()["instructions"],
                       source_run_id=item["run_id"])
    assert saved["name"] == "Proposal follow-up"
    assert (await mayank.post(f"/ventures/{v}/skills", json={"name": "proposal FOLLOW-up", "instructions": "1. x y z",
                                                             "trigger": "manual"})).status_code == 409


async def test_roles(shop, fake_llm, client):
    mayank, operator, approver, v = shop["mayank"], shop["operator"], shop["approver"], shop["v"]
    s = await make(mayank, v, name="Owner's skill")
    assert (await approver.post(f"/ventures/{v}/skills", json={"name": "Nope", "instructions": "1. nope nope",
                                                               "trigger": "manual"})).status_code == 403
    assert (await approver.post(f"/ventures/{v}/skills/{s['id']}/run")).status_code == 403
    # everyone in the business sees skills; only their maker or an admin changes them
    seen = (await operator.get(f"/ventures/{v}/skills")).json()
    assert [x["name"] for x in seen] == ["Owner's skill"] and seen[0]["can_edit"] is False
    body = {"name": "Changed", "instructions": "1. changed steps", "trigger": "manual"}
    assert (await operator.put(f"/ventures/{v}/skills/{s['id']}", json=body)).status_code == 403
    assert (await operator.delete(f"/ventures/{v}/skills/{s['id']}")).status_code == 403
    mine = await make(operator, v, name="Operator's skill")
    assert (await operator.put(f"/ventures/{v}/skills/{mine['id']}", json=body)).status_code == 200
    planner(fake_llm, {"answer": "ok"})
    assert (await operator.post(f"/ventures/{v}/skills/{s['id']}/run")).status_code == 201   # anyone who can work runs them
    stranger = await make_actor(client, "skill-stranger")
    assert (await stranger.get(f"/ventures/{v}/skills")).status_code in (403, 404)
    assert (await mayank.delete(f"/ventures/{v}/skills/{mine['id']}")).status_code == 204       # admins can remove
