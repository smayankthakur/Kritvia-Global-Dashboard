"""Autopilot (services/autopilot.py, migration 0080): one switch per business; routine work goes out by itself,
money, complaints, orders and everything outside the list still wait for a person, and the database enforces
the list whatever the code asks for."""
from __future__ import annotations

import uuid

import asyncpg
import pytest

from conftest import ADMIN_DSN
from test_auto_reply import configure, meta, script, studio  # noqa: F401  (fixtures)

from kritvia_api.plans import PLANS
from kritvia_api.services import autopilot as ap
from kritvia_api.services.front_door import autopilot_word

PNID = "5550006661"


def wa_msg(mid: str, body: str, sender: str, name: str = "Kavya") -> dict:
    return {"object": "whatsapp_business_account", "entry": [{"id": "1", "changes": [{"field": "messages", "value": {
        "messaging_product": "whatsapp", "metadata": {"display_phone_number": "919876566661", "phone_number_id": PNID},
        "contacts": [{"profile": {"name": name}, "wa_id": sender}],
        "messages": [{"from": sender, "id": mid, "timestamp": "1700000000", "type": "text", "text": {"body": body}}]}}]}]}


async def wire(studio) -> None:
    r = await studio["mayank"].post(f"/ventures/{studio['v']}/connectors/whatsapp",
                                    json={"phone_number_id": PNID, "access_token": "EAAB" + "c" * 40})
    assert r.status_code in (201, 409), r.text


# ----------------------------------------------------------------------------------- plan rule --
def test_what_each_plan_lets_autopilot_do():
    free, starter, growth = PLANS["free"], PLANS["starter"], PLANS["growth"]
    assert ap.plan_allows(free, "inbox", "whatsapp.send")              # replying by itself: every plan
    assert not ap.plan_allows(free, "reviews", "google.review_reply")   # the trial's agents ask
    assert ap.plan_allows(starter, "reviews", "google.review_reply")    # Starter: the agent's first kind
    assert not ap.plan_allows(starter, "reviews", "whatsapp.template")
    assert ap.plan_allows(starter, "collections", "gmail.send")         # channels count as one kind
    assert ap.plan_allows(growth, "reviews", "whatsapp.template")
    for plan in (free, starter, growth):                                  # never on the list
        assert not ap.plan_allows(plan, "collections", "invoices.send")
        assert not ap.plan_allows(plan, "proposal", "gmail.send")
        assert not ap.plan_allows(plan, "campaigns", "campaign.send")


def test_pause_and_resume_words():
    assert autopilot_word("PAUSE") == "pause" and autopilot_word("/pause") == "pause"
    assert autopilot_word("Resume!") == "resume" and autopilot_word("autopilot chalu karo") == "resume"
    assert autopilot_word("please pause the order") is None


def test_the_evening_summary():
    subject, body = ap.summary_text("Sharma Studio", ap.Day(by_itself={"inbox": 12, "reviews": 2}, waiting=3,
                                                              failed=1, held=2))
    assert subject == "Autopilot: 14 done by itself, 3 waiting for you"
    assert "12 answered customers" in body and "PAUSE" in body and "1 run(s) failed" in body


# ------------------------------------------------------------------------------ switch and API --
@pytest.mark.asyncio
async def test_off_until_an_admin_switches_it_on(studio, world):
    v = studio["v"]
    got = (await studio["mayank"].get(f"/ventures/{v}/autopilot")).json()
    assert got["on"] is False and {j["agent"] for j in got["jobs"]} >= {"inbox", "reviews", "collections"}
    assert any("Refunds" in x for x in got["still_asks"])
    assert (await world["mallory"].put(f"/ventures/{v}/autopilot", json={"on": True})).status_code in (403, 404)
    r = await studio["mayank"].put(f"/ventures/{v}/autopilot", json={"on": True})
    assert r.status_code == 200 and r.json()["on"] is True and r.json()["changed_at"]
    await studio["mayank"].put(f"/ventures/{v}/autopilot", json={"on": False})


# --------------------------------------------------------------------------- database guard --
@pytest.mark.asyncio
async def test_the_database_only_lets_autopilot_approve_its_list(studio):
    v = uuid.UUID(studio["v"])
    c = await asyncpg.connect(ADMIN_DSN)
    try:
        org = await c.fetchval("SELECT org_id FROM ventures WHERE id = $1", v)
        user = await c.fetchval("SELECT id FROM users LIMIT 1")

        async def run(workflow: str) -> uuid.UUID:
            return await c.fetchval("INSERT INTO workflow_runs (org_id, venture_id, workflow, current_step, run_as, status, finished_at)"
                                    " VALUES ($1, $2, $3, 'draft', $4, 'completed', now()) RETURNING id", org, v, workflow, user)

        async def card(run_id, agent, step, action, sensitive=False):
            return await c.fetchval(
                "INSERT INTO approvals (org_id, venture_id, run_id, step, agent, action, capability, title, payload_enc,"
                " status, sensitive) VALUES ($1, $2, $3, $4, $5, $6, 'send', 'x', '\\x00', 'auto_approved', $7)"
                " RETURNING id", org, v, run_id, step, agent, action, sensitive)
        reminder = await run("collections")
        with pytest.raises(asyncpg.exceptions.InsufficientPrivilegeError):      # autopilot off
            await card(reminder, "collections", "draft", "gmail.send")
        await c.execute("UPDATE venture_settings SET autopilot = true WHERE venture_id = $1", v)
        assert await card(reminder, "collections", "draft", "gmail.send")      # on: on the list
        with pytest.raises(asyncpg.exceptions.InsufficientPrivilegeError):      # never sensitive
            await card(reminder, "collections", "draft", "gmail.send", sensitive=True)
        triage = await run("lead_triage")
        with pytest.raises(asyncpg.exceptions.InsufficientPrivilegeError):      # proposals: never
            await card(triage, "proposal", "draft", "gmail.send")
        inbox = await run("inbox_assistant")
        with pytest.raises(asyncpg.exceptions.InsufficientPrivilegeError):      # the owner's draft: never
            await card(inbox, "inbox", "owner_draft", "whatsapp.send")
        with pytest.raises(asyncpg.exceptions.InsufficientPrivilegeError):      # a step of another workflow
            await card(reminder, "reviews", "reply", "google.review_reply")
    finally:
        await c.execute("UPDATE venture_settings SET autopilot = false WHERE venture_id = $1", v)
        await c.close()


# ------------------------------------------------------------------------- inbox on autopilot --
@pytest.mark.asyncio
async def test_with_autopilot_on_the_inbox_replies_and_money_still_waits(studio, client, fake_llm, meta):
    from test_auto_reply import approvals, hook, latest_run, sent_to
    await wire(studio)
    await configure(studio)                                   # "reply by itself" not ticked
    await studio["mayank"].put(f"/ventures/{studio['v']}/autopilot", json={"on": True})
    try:
        script(fake_llm, body="Haan ji, website design hum karte hain!")
        await hook(client, wa_msg(f"wamid.{uuid.uuid4().hex[:10]}", "Website banate ho?", "919822200401"))
        run = await latest_run(studio)
        assert [(a["step"], a["status"]) for a in await approvals(run["id"])] == [("draft", "auto_approved")]
        assert sent_to(meta, "919822200401")[0].startswith("Haan ji, website design hum karte hain!")
        script(fake_llm, body="Sure, refund ho jayega!")
        await hook(client, wa_msg(f"wamid.{uuid.uuid4().hex[:10]}", "Mujhe refund chahiye", "919822200402"))
        run = await latest_run(studio)
        assert [(a["step"], a["status"]) for a in await approvals(run["id"])] == [
            ("hold", "auto_approved"), ("owner_draft", "pending")]
        assert "refund ho jayega" not in " ".join(sent_to(meta, "919822200402"))
    finally:
        await studio["mayank"].put(f"/ventures/{studio['v']}/autopilot", json={"on": False})
    # off again: drafts wait
    script(fake_llm, body="Ji zaroor!")
    await hook(client, wa_msg(f"wamid.{uuid.uuid4().hex[:10]}", "Kal khule ho?", "919822200403"))
    run = await latest_run(studio)
    assert [(a["step"], a["status"]) for a in await approvals(run["id"])] == [("draft", "pending")]
