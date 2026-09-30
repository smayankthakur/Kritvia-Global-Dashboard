"""Days 15–30 exit criteria on a real workflow:
a run pauses at an approval interrupt, survives a restart, and resumes on approval.
Plus the Sitelytc guardrails: prices from the rate card only, dedupe, redraft on rejection."""
from __future__ import annotations

import uuid

import asyncpg
import pytest

from conftest import ADMIN_DSN, join, make_actor

pytestmark = pytest.mark.asyncio

RATE_CARD = {"items": [
    {"code": "web_nextjs", "name": "Next.js website", "unit": "project", "rate_inr": "150000"},
    {"code": "page_extra", "name": "Additional page", "unit": "page", "rate_inr": "8000"},
    {"code": "ai_workflow", "name": "AI automation workflow", "unit": "workflow", "rate_inr": "60000"},
    {"code": "vapt_web", "name": "Web application VAPT", "unit": "assessment", "rate_inr": "90000"},
]}

INQUIRY = {"from_name": "Priya Nair", "from_email": "priya@acmefoods.in", "company": "Acme Foods",
           "subject": "Website + ordering automation",
           "body": "Hi, we need a new Next.js website with 5 extra pages and an AI workflow to auto-reply "
                   "to catering orders. Budget around 3-4 lakh, timeline 6 weeks. Urgent."}


def script_triage(fake, *, stray_price: bool = False):
    fake.on("You triage inbound inquiries", {
        "contact_name": "Priya Nair", "company": "Acme Foods", "summary": "Acme Foods wants a website and automation.",
        "requirements": ["Next.js website", "5 extra pages", "AI auto-reply for catering orders"],
        "scope": [{"code": "web_nextjs", "qty": 1}, {"code": "page_extra", "qty": 5},
                  {"code": "ai_workflow", "qty": 1}, {"code": "made_up_code", "qty": 3}],
        "budget_text": "3-4 lakh", "timeline": "6 weeks", "urgency": "high", "is_spam": False})
    fake.on("Assess how well this inquiry fits", {"fit": "strong", "reason": "core services"})
    body = "We will build it. " + ("It costs ₹99,999. " if stray_price else "") + "See [1]."
    fake.on("proposal writer", {"subject": "Proposal: Acme Foods web + automation",
                                "email_body": "Hi Priya, please find our proposal.",
                                "proposal": "## Understanding\n" + body, "used_sources": [1]})


@pytest.fixture
async def site(world, client):
    mayank = world["mayank"]
    r = await mayank.put(f"/ventures/{world['site']}/rate-card", json=RATE_CARD)
    assert r.status_code == 200, r.text
    await mayank.put(f"/ventures/{world['site']}/settings", json={"kind": "software"})
    # a dedicated approver for this venture
    approver = await make_actor(client, "approver")
    await join(mayank, approver, world["org"], world["site"], "approver")
    return {**world, "approver": approver}


async def _run(actor, venture, run_id):
    return (await actor.get(f"/ventures/{venture}/runs/{run_id}")).json()


async def test_triage_pauses_prices_from_rate_card_and_resumes(site, fake_llm):
    alice, approver, v = site["alice"], site["approver"], site["site"]
    script_triage(fake_llm)
    r = await alice.post(f"/ventures/{v}/leads/inquiry", json=INQUIRY)
    assert r.status_code == 202, r.text
    run_id = r.json()["run_id"]

    run = await _run(alice, v, run_id)
    assert run["status"] == "waiting", run
    assert run["current_step"] == "send_proposal"
    assert [s["step"] for s in run["steps"]] == ["extract", "upsert_lead", "retrieve", "score", "price", "draft"]

    inbox = (await approver.get("/approvals/inbox")).json()
    mine = [a for a in inbox if a["run_id"] == run_id]
    assert len(mine) == 1 and mine[0]["action"] == "gmail.send" and mine[0]["can_decide"]
    body = mine[0]["payload"]["body"]
    # 150000 + 5*8000 + 60000 = 250000; GST 45000; total 295000. The invented code was dropped.
    assert "₹2,50,000.00" in body and "₹45,000.00" in body and "₹2,95,000.00" in body
    assert "made_up_code" not in body
    # Alice is an operator: she can see the draft but not decide it
    alice_view = [a for a in (await alice.get("/approvals/inbox")).json() if a["run_id"] == run_id][0]
    assert alice_view["can_decide"] is False
    d = await alice.post(f"/ventures/{v}/approvals/{mine[0]['id']}/decision", json={"decision": "approve"})
    assert d.status_code == 404

    lead = [l for l in (await alice.get(f"/ventures/{v}/leads")).json() if l["email"] == "priya@acmefoods.in"][0]
    assert lead["priority"] == "hot" and lead["score"] >= 70 and lead["budget_inr"] == "400000.00"

    # --- approve with an edit: the edited text is what gets sent
    edited = dict(mine[0]["payload"], subject="Proposal for Acme Foods (revised)")
    d = await approver.post(f"/ventures/{v}/approvals/{mine[0]['id']}/decision",
                            json={"decision": "approve", "edited_payload": edited})
    assert d.status_code == 200, d.text
    assert d.json()["status"] == "edited" and d.json()["diff"][0]["field"] == "subject"

    run = await _run(alice, v, run_id)
    assert run["status"] == "waiting" and run["current_step"] == "send_invite"   # now waiting on the invite
    invite = [a for a in (await approver.get("/approvals/inbox")).json() if a["run_id"] == run_id][0]
    assert invite["action"] == "calendar.create_event"
    assert (await approver.post(f"/ventures/{v}/approvals/{invite['id']}/decision",
                                json={"decision": "approve"})).status_code == 200
    run = await _run(alice, v, run_id)
    assert run["status"] == "completed" and run["outcome"] == "proposal_sent_call_booked"

    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        sent = await conn.fetch("SELECT o.channel, o.subject, o.transport, o.status FROM outbox_messages o"
                                " JOIN approvals a ON a.id = o.approval_id WHERE a.run_id = $1 ORDER BY o.created_at",
                                uuid.UUID(run_id))
        prop = await conn.fetchrow("SELECT status, total_inr FROM proposals WHERE run_id = $1", uuid.UUID(run_id))
        trust = await conn.fetchrow("SELECT edited, consecutive_clean FROM agent_trust WHERE venture_id = $1"
                                    " AND agent = 'proposal' AND action = 'gmail.send'", uuid.UUID(v))
    finally:
        await conn.close()
    assert [(s["channel"], s["subject"]) for s in sent] == [
        ("email", "Proposal for Acme Foods (revised)"), ("calendar", "Discovery call — Acme Foods × Sitelytc")]
    assert all(s["transport"] == "log" and s["status"] == "logged" for s in sent)
    assert prop["status"] == "sent" and str(prop["total_inr"]) == "295000.00"
    assert trust["edited"] == 1 and trust["consecutive_clean"] == 0


async def test_duplicate_inquiry_updates_existing_lead(site, fake_llm):
    alice, v = site["alice"], site["site"]
    script_triage(fake_llm)
    async def acme():
        return [l for l in (await alice.get(f"/ventures/{v}/leads")).json() if l["company"] == "Acme Foods"]
    before = await acme()
    q = dict(INQUIRY, from_email="dup@acmefoods.in")   # same company, another person, within the window
    await alice.post(f"/ventures/{v}/leads/inquiry", json=q)
    await alice.post(f"/ventures/{v}/leads/inquiry", json=q)
    after = await acme()
    assert len(after) == 1
    assert after[0]["inquiry_count"] == (before[0]["inquiry_count"] if before else 0) + 2 - (0 if before else 1)


async def test_stray_prices_from_the_model_never_reach_the_client(site, fake_llm):
    alice, approver, v = site["alice"], site["approver"], site["site"]
    script_triage(fake_llm, stray_price=True)
    run_id = (await alice.post(f"/ventures/{v}/leads/inquiry",
                               json=dict(INQUIRY, from_email="stray@acmefoods.in"))).json()["run_id"]
    a = [x for x in (await approver.get("/approvals/inbox")).json() if x["run_id"] == run_id][0]
    assert "99,999" not in a["payload"]["body"]
    assert len(fake_llm.chat_calls("proposal writer")) == 2   # asked to redraft once


async def test_rejection_with_feedback_redrafts_then_gives_up(site, fake_llm):
    alice, approver, v = site["alice"], site["approver"], site["site"]
    script_triage(fake_llm)
    run_id = (await alice.post(f"/ventures/{v}/leads/inquiry",
                               json=dict(INQUIRY, from_email="rej@acmefoods.in"))).json()["run_id"]
    for i in range(3):
        a = [x for x in (await approver.get("/approvals/inbox")).json() if x["run_id"] == run_id][0]
        r = await approver.post(f"/ventures/{v}/approvals/{a['id']}/decision",
                                json={"decision": "reject", "comment": f"too long ({i})"})
        assert r.status_code == 200
    run = await _run(alice, v, run_id)
    assert run["status"] == "completed" and run["outcome"] == "proposal_rejected"
    assert "too long (1)" in fake_llm.chat_calls("proposal writer")[-1]["prompt"]


async def test_spam_is_dropped(site, fake_llm):
    alice, v = site["alice"], site["site"]
    fake_llm.on("You triage inbound inquiries", {"summary": "SEO pitch", "is_spam": True})
    run_id = (await alice.post(f"/ventures/{v}/leads/inquiry",
                               json={"from_email": "seo@spam.biz", "body": "We rank you #1 on Google"})).json()["run_id"]
    run = await _run(alice, v, run_id)
    assert run["outcome"] == "spam"
