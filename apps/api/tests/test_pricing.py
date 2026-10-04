"""Pricing 2026–27: which agents, integrations, proposals, memory and autonomy each plan includes."""
from __future__ import annotations

import dataclasses
import uuid

import asyncpg
from sqlalchemy import text

from conftest import ADMIN_DSN, make_actor
from kritvia_api import plans
from kritvia_api.config import get_settings
from kritvia_api.db.session import tenant_tx
from test_lead_triage import INQUIRY, RATE_CARD, script_triage


async def _org(client, monkeypatch, plan_code: str = "free", kind: str = "kitchen"):
    monkeypatch.setattr(get_settings(), "default_plan", "free")
    owner = await make_actor(client, "priceowner")
    org = (await owner.post("/orgs", json={"name": "Price Co", "slug": "price-" + uuid.uuid4().hex[:8]})).json()["id"]
    v = await owner.post(f"/orgs/{org}/ventures", json={"name": "Biz", "slug": "biz", "kind": kind})
    assert v.status_code == 201, v.text
    if plan_code != "free":
        await _set_plan(org, plan_code)
    return owner, org, v.json()["id"]


async def _set_plan(org: str, code: str) -> None:
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute("SELECT set_org_plan($1, $2, now() + interval '30 days')", uuid.UUID(org), code)
    finally:
        await conn.close()


def test_price_list_matches_2026_27():
    p = plans.PLANS
    assert [(p[c].price_inr, p[c].price_annual_inr) for c in ("starter", "growth", "scale")] == \
        [(2499, 24_990), (6999, 69_990), (14_999, 1_49_990)]
    assert [(p[c].max_ventures, p[c].max_members, p[c].monthly_tokens) for c in ("free", "starter", "growth", "scale")] == \
        [(1, 2, 300_000), (1, 5, 3_000_000), (3, 15, 15_000_000), (10, 50, 50_000_000)]
    assert p["growth"].featured and plans.plan("pro").code == "growth"


async def test_free_gets_core_agents_only_starter_adds_its_own_kind(client, monkeypatch):
    owner, org, vid = await _org(client, monkeypatch, kind="kitchen")
    cfg = {"enabled": True, "settings": {}, "instructions": ""}
    r = await owner.put(f"/ventures/{vid}/workflow-configs/kitchen_daily", json=cfg)
    assert r.status_code == 402 and "Free plan doesn't include Nightly kitchen plan" in r.text
    assert (await owner.post(f"/ventures/{vid}/kitchen/run", json={})).status_code == 402
    assert (await owner.put(f"/ventures/{vid}/workflow-configs/inbox_assistant", json=cfg)).status_code == 200

    await _set_plan(org, "starter")
    assert (await owner.put(f"/ventures/{vid}/workflow-configs/kitchen_daily", json=cfg)).status_code == 200


async def test_integrations_follow_the_plan(client, monkeypatch, services):
    owner, org, vid = await _org(client, monkeypatch, kind="general")
    wa = {"phone_number_id": "1234567", "access_token": "x" * 40}
    r = await owner.post(f"/ventures/{vid}/connectors/whatsapp", json=wa)
    assert r.status_code == 402 and "WhatsApp Business" in r.text
    assert (await owner.post(f"/ventures/{vid}/connectors/google/drive-import", json={})).status_code in (402, 422)
    r = await owner.post(f"/ventures/{vid}/connectors/tally/import", files={"file": ("t.xml", b"<ENVELOPE/>", "text/xml")})
    assert r.status_code == 402 and "Tally" in r.text

    await _set_plan(org, "starter")   # Starter: WhatsApp yes, Tally still no
    r = await owner.post(f"/ventures/{vid}/connectors/tally/import", files={"file": ("t.xml", b"<ENVELOPE/>", "text/xml")})
    assert r.status_code == 402 and "upgrade to Growth" in r.text
    from kritvia_api.services.whatsapp import WhatsAppError

    async def refuse(*_a, **_k):
        raise WhatsAppError("Meta rejected the token")
    monkeypatch.setattr(services.whatsapp, "check_number", refuse)
    r = await owner.post(f"/ventures/{vid}/connectors/whatsapp", json=wa)
    assert r.status_code == 422 and "Meta rejected" in r.text    # past the plan check, on to Meta


async def test_business_memory_is_capped(client, monkeypatch):
    owner, org, vid = await _org(client, monkeypatch, kind="general")
    note = {"title": "Pricing notes", "text": "We quote GST separately.", "kind": "note"}
    assert (await owner.post(f"/ventures/{vid}/notes", json=note)).status_code == 201
    conn = await asyncpg.connect(ADMIN_DSN)
    try:   # pretend the Free plan's 500 MB is all but used
        await conn.execute("UPDATE documents SET size_bytes = 500 * 1024 * 1024 - 1000 WHERE venture_id = $1", uuid.UUID(vid))
    finally:
        await conn.close()
    plan = (await owner.get(f"/orgs/{org}/plan")).json()
    assert plan["storage_bytes"] >= 499 * 1024 * 1024 and plan["plan"]["storage_bytes"] == 500 * 1024 * 1024
    big = {"title": "Big", "text": "x" * 150_000, "kind": "note"}
    r = await owner.post(f"/ventures/{vid}/notes", json=big)
    assert r.status_code == 402 and "business memory is full on the Free plan" in r.text


async def test_free_proposals_stop_at_the_monthly_allowance(client, monkeypatch, fake_llm):
    monkeypatch.setitem(plans.PLANS, "free", dataclasses.replace(plans.PLANS["free"], proposals_per_month=0))
    owner, org, vid = await _org(client, monkeypatch, kind="software")
    assert (await owner.put(f"/ventures/{vid}/rate-card", json=RATE_CARD)).status_code == 200
    script_triage(fake_llm)
    r = await owner.post(f"/ventures/{vid}/leads/inquiry", json=INQUIRY)
    assert r.status_code == 202, r.text
    run = (await owner.get(f"/ventures/{vid}/runs/{r.json()['run_id']}")).json()
    assert run["status"] == "completed" and run["outcome"] == "proposal_limit"
    assert (await owner.get(f"/ventures/{vid}/proposals")).json() == []
    assert [x["name"] for x in (await owner.get(f"/ventures/{vid}/leads")).json()] == ["Priya Nair"]


async def test_starter_allows_one_autonomous_action_per_agent_and_downgrade_trims(client, monkeypatch):
    owner, org, vid = await _org(client, monkeypatch, plan_code="starter", kind="software")
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        for action in ("gmail.send", "calendar.create_event"):
            await conn.execute("INSERT INTO agent_trust (org_id, venture_id, agent, action, consecutive_clean,"
                               " approved_clean) VALUES ($1, $2, 'proposal', $3, 100, 100)",
                               uuid.UUID(org), uuid.UUID(vid), action)
    finally:
        await conn.close()
    ok = await owner.post(f"/ventures/{vid}/trust/proposal/gmail.send", json={"auto_run": True, "reason": "trusted"})
    assert ok.status_code == 200, ok.text
    r = await owner.post(f"/ventures/{vid}/trust/proposal/calendar.create_event", json={"auto_run": True, "reason": "x y z"})
    assert r.status_code == 402 and "1 kind of action" in r.text

    await _set_plan(org, "growth")
    r = await owner.post(f"/ventures/{vid}/trust/proposal/calendar.create_event", json={"auto_run": True, "reason": "x y z"})
    assert r.status_code == 200
    # back down to Free (as the billing webhook does): every earned action is switched off
    await _set_plan(org, "free")
    async with tenant_tx(None, "system") as c:
        assert (await c.execute(text("SELECT limit_autonomy(:o, 0)"), {"o": uuid.UUID(org)})).scalar() == 2
    assert not any(t["auto_run"] for t in (await owner.get(f"/ventures/{vid}/trust")).json())
    # a stranger cannot call it for someone else's organisation
    other = await make_actor(client, "stranger")
    async with tenant_tx(other.id) as c:
        try:
            await c.execute(text("SELECT limit_autonomy(:o, 0)"), {"o": uuid.UUID(org)})
            raise AssertionError("expected a permission error")
        except Exception as exc:   # noqa: BLE001
            assert "not permitted" in str(exc)
