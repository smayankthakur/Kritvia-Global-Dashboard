"""Phase 2, Earn trust: invoices are drafted by themselves (a booking marked done, a lead marked won), wait for
a person to issue them, and an agent asks once to send by itself the moment its clean streak earns it."""
from __future__ import annotations

import uuid
from datetime import datetime

import asyncpg
import httpx
import pytest

from conftest import ADMIN_DSN
from kritvia_api.services import places_keys
from kritvia_api.services.mailer import get_mailer
from kritvia_api.services.places import PlacesClient
from test_pricing import _org
from test_prospector import FakePlaces, leads, run, script_outreach


def mail_to(subject_part: str) -> list:
    return [m for m in get_mailer().outbox if subject_part in m["Subject"]]


async def admin(sql: str, *args):
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        return await conn.fetch(sql, *args)
    finally:
        await conn.close()


@pytest.fixture
async def shop(client, monkeypatch):
    owner, org, v = await _org(client, monkeypatch, plan_code="growth", kind="software")
    name = f"Trusty {uuid.uuid4().hex[:6]}"
    await owner.put(f"/ventures/{v}/settings", json={"kind": "software", "business_name": name, "city": "Delhi"})
    return {"owner": owner, "org": org, "v": v, "name": name}


async def invoices(actor, v, show="all"):
    return (await actor.get(f"/ventures/{v}/invoices", params={"show": show})).json()


# --------------------------------------------------------------------------------- bookings --
async def test_a_booking_marked_done_drafts_its_invoice(shop, client):
    owner, v = shop["owner"], shop["v"]
    await owner.put(f"/ventures/{v}/booking-settings", json={
        "hours": {d: [["00:00", "23:59"]] for d in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")},
        "slot_minutes": 30, "notice_hours": 0, "capacity": 1, "use_calendar": False})
    cut = (await owner.post(f"/ventures/{v}/booking-services",
                            json={"name": "Site audit", "minutes": 30, "price_paise": 250000})).json()
    free = (await owner.get(f"/ventures/{v}/booking-slots", params={"service_id": cut["id"], "days": 3})).json()["slots"]
    b = (await owner.post(f"/ventures/{v}/bookings", json={"service_id": cut["id"], "starts_at": free[0],
                                                           "customer_name": "Ravi Traders", "phone": "98111 22233"})).json()
    assert (await invoices(owner, v))["invoices"] == []
    await owner.patch(f"/ventures/{v}/bookings/{b['id']}", json={"status": "done"})
    got = await invoices(owner, v, "draft")
    assert len(got["invoices"]) == 1
    d = got["invoices"][0]
    assert d["status"] == "draft" and d["source"] == "booking" and d["amount_paise"] == 250000
    assert d["customer_name"] == "Ravi Traders" and d["customer_phone"] == "919811122233"
    assert "Site audit" in d["notes"] and d["issued_on"] is None
    # a draft isn't owed: not in the totals, not unpaid, not reminded, no payment page
    assert got["totals"]["draft_count"] == 1 and got["totals"]["outstanding_paise"] == 0
    assert (await invoices(owner, v, "open"))["invoices"] == []
    token = d["pay_url"].rstrip("/").rsplit("/", 1)[-1]
    assert (await client.get(f"/public/pay/{token}")).status_code == 404
    # marking it done again (or back and forth) never drafts a second one
    await owner.patch(f"/ventures/{v}/bookings/{b['id']}", json={"status": "confirmed"})
    await owner.patch(f"/ventures/{v}/bookings/{b['id']}", json={"status": "done"})
    assert len((await invoices(owner, v))["invoices"]) == 1
    # issuing it dates it today and makes it owed
    r = await owner.patch(f"/ventures/{v}/invoices/{d['id']}", json={"status": "open"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "open" and r.json()["issued_on"] is not None
    t = (await invoices(owner, v, "open"))["totals"]
    assert t["outstanding_paise"] == 250000 and t["draft_count"] == 0


async def test_an_old_draft_issued_is_due_a_week_later(shop):
    owner, v = shop["owner"], shop["v"]
    rows = await admin(
        "INSERT INTO invoices (org_id, venture_id, customer_name, amount_paise, due_on, status, source)"
        " VALUES ($1, $2, 'Old Co', 10000, current_date - 20, 'draft', 'booking') RETURNING id",
        uuid.UUID(shop["org"]), uuid.UUID(v))
    r = (await owner.patch(f"/ventures/{v}/invoices/{rows[0]['id']}", json={"status": "open"})).json()
    assert r["status"] == "open" and r["overdue_days"] == 0
    assert datetime.fromisoformat(r["due_on"]).date() > datetime.fromisoformat(r["issued_on"]).date()


# ------------------------------------------------------------------------------- won leads --
async def test_a_lead_marked_won_drafts_the_invoice_from_its_proposal(shop):
    owner, v = shop["owner"], shop["v"]
    lead = (await owner.post(f"/ventures/{v}/leads", json={"name": "Asha", "company": "Asha Foods",
                                                           "email": "asha@ashafoods.in"})).json()
    await admin("INSERT INTO proposals (org_id, venture_id, lead_id, title, content_enc, subtotal_inr, gst_inr,"
                " total_inr, status, sent_at) VALUES ($1, $2, $3, 'Website', '\\x00', 10000, 1800, 11800.50,"
                " 'sent', now())", uuid.UUID(shop["org"]), uuid.UUID(v), uuid.UUID(lead["id"]))
    r = await owner.patch(f"/ventures/{v}/leads/{lead['id']}", json={"status": "won"})
    assert r.status_code == 200, r.text
    got = (await invoices(owner, v, "draft"))["invoices"]
    assert len(got) == 1
    d = got[0]
    assert d["source"] == "proposal" and d["amount_paise"] == 1180050
    assert d["customer_name"] == "Asha Foods" and d["customer_email"] == "asha@ashafoods.in"
    status = await admin("SELECT status FROM proposals WHERE lead_id = $1", uuid.UUID(lead["id"]))
    assert status[0]["status"] == "accepted"
    # won again later: still one draft
    await owner.patch(f"/ventures/{v}/leads/{lead['id']}", json={"status": "qualified"})
    await owner.patch(f"/ventures/{v}/leads/{lead['id']}", json={"status": "won"})
    assert len((await invoices(owner, v))["invoices"]) == 1
    # discarding it is cancelling it
    r = await owner.patch(f"/ventures/{v}/invoices/{d['id']}", json={"status": "cancelled"})
    assert r.json()["status"] == "cancelled"


async def test_a_lead_won_without_a_proposal_drafts_nothing(shop):
    owner, v = shop["owner"], shop["v"]
    lead = (await owner.post(f"/ventures/{v}/leads", json={"name": "Nobody"})).json()
    await owner.patch(f"/ventures/{v}/leads/{lead['id']}", json={"status": "won"})
    assert (await invoices(owner, v))["invoices"] == []


# -------------------------------------------------------------------------------- trust ask --
@pytest.fixture
def places(services, monkeypatch):
    fake = FakePlaces()
    monkeypatch.setattr(services, "places", PlacesClient("test-key", transport=httpx.MockTransport(fake)))
    monkeypatch.setattr(places_keys, "SERVER_KEY_PLANS", frozenset({"internal", "growth"}))
    return fake


async def _one_draft(shop, fake_llm) -> dict:
    """One prospecting email waiting for a yes."""
    owner, v = shop["owner"], shop["v"]
    await owner.put(f"/ventures/{v}/workflow-configs/prospector", json={"enabled": True, "settings": {
        "searches": "restaurants in Nangloi, Delhi", "new_per_day": 1, "send_without_asking": False}})
    script_outreach(fake_llm)
    first = await run(owner, v)
    lead = (await leads(owner, v)).get("Ramesh Dhaba")
    assert lead, first.get("summary")
    await owner.patch(f"/ventures/{v}/leads/{lead['id']}", json={"email": f"r{uuid.uuid4().hex[:6]}@example.com"})
    await owner.post(f"/ventures/{v}/leads/{lead['id']}/outreach", json={"action": "resume"})
    await run(owner, v)
    pending = (await owner.get(f"/ventures/{v}/approvals?status=pending")).json()
    assert len(pending) == 1, pending
    return pending[0]


async def test_the_agent_asks_once_when_its_streak_earns_trust(shop, places, fake_llm):
    owner, v = shop["owner"], shop["v"]
    a = await _one_draft(shop, fake_llm)
    await admin("UPDATE venture_settings SET trust_threshold = 5 WHERE venture_id = $1", uuid.UUID(v))
    await admin("INSERT INTO agent_trust (org_id, venture_id, agent, action, consecutive_clean, approved_clean)"
                " VALUES ($1, $2, $3, $4, 4, 4) ON CONFLICT (venture_id, agent, action)"
                " DO UPDATE SET consecutive_clean = 4, approved_clean = 4",
                uuid.UUID(shop["org"]), uuid.UUID(v), a["agent"], a["action"])
    before = len(mail_to("may it send"))
    r = await owner.post(f"/ventures/{v}/approvals/{a['id']}/decision", json={"decision": "approve"})
    assert r.status_code == 200, r.text
    got = mail_to("may it send")
    assert len(got) == before + 1
    assert got[-1]["To"] == owner.email and "emails" in got[-1]["Subject"]
    assert f"/v/{v}/trust" in got[-1].get_content()
    rows = (await owner.get(f"/ventures/{v}/trust")).json()
    row = next(t for t in rows if t["agent"] == a["agent"] and t["action"] == a["action"])
    assert row["eligible"] and not row["auto_run"] and row["what"] == "emails" and row["title"]
    asked = await admin("SELECT count(*) AS n FROM audit_log WHERE venture_id = $1 AND action = 'autonomy.asked'",
                        uuid.UUID(v))
    assert asked[0]["n"] == 1
    # one tap, from the Trust page
    ok = await owner.post(f"/ventures/{v}/trust/{a['agent']}/{a['action']}",
                          json={"auto_run": True, "reason": "Earned: 5 approved unchanged in a row"})
    assert ok.status_code == 200, ok.text


async def test_no_ask_below_the_threshold_or_after_it(shop, places, fake_llm):
    owner, v = shop["owner"], shop["v"]
    a = await _one_draft(shop, fake_llm)
    await admin("UPDATE venture_settings SET trust_threshold = 5 WHERE venture_id = $1", uuid.UUID(v))
    await admin("INSERT INTO agent_trust (org_id, venture_id, agent, action, consecutive_clean, approved_clean)"
                " VALUES ($1, $2, $3, $4, 9, 9) ON CONFLICT (venture_id, agent, action)"
                " DO UPDATE SET consecutive_clean = 9, approved_clean = 9",
                uuid.UUID(shop["org"]), uuid.UUID(v), a["agent"], a["action"])
    before = len(mail_to("may it send"))
    await owner.post(f"/ventures/{v}/approvals/{a['id']}/decision", json={"decision": "approve"})
    assert len(mail_to("may it send")) == before      # it already asked when the streak hit 5
