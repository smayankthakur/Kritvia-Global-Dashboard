"""Custom workflows (Scale and Enterprise): a business's own agent. Records that match the trigger are
found once a day; each is handled once; an email to the customer waits for a yes; a note goes to the
maker. Plans without custom workflows can't make or run them."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import asyncpg
import pytest

from conftest import ADMIN_DSN, join, make_actor
from kritvia_api.config import get_settings

pytestmark = pytest.mark.asyncio
IST = ZoneInfo("Asia/Kolkata")


async def _plan(org: str, plan: str) -> None:
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute("INSERT INTO org_plans (org_id, plan) VALUES ($1, $2) ON CONFLICT (org_id) DO UPDATE SET plan = $2",
                           uuid.UUID(org), plan)
    finally:
        await conn.close()


async def test_custom_workflow_email_and_notify(client, monkeypatch, fake_llm, services):
    from kritvia_api.services import custom_workflows as cw
    from kritvia_api.services.mailer import get_mailer
    monkeypatch.setattr(get_settings(), "default_plan", "free")
    owner = await make_actor(client, "cw-owner")
    org = (await owner.post("/orgs", json={"name": "Custom Co", "slug": f"cw-{uuid.uuid4().hex[:8]}"})).json()["id"]
    v = (await owner.post(f"/orgs/{org}/ventures", json={"name": "Studio", "slug": f"cw-{uuid.uuid4().hex[:6]}"})).json()["id"]
    await owner.put(f"/ventures/{v}/settings", json={"kind": "general", "business_name": "Studio", "city": "Delhi"})
    viewer = await make_actor(client, "cw-viewer")
    await join(owner, viewer, org, v, "viewer")
    body = {"name": "Gentle nudge", "trigger": "invoice_overdue", "wait_days": 3,
            "instructions": "Remind them kindly and offer to split the payment in two.", "action": "email", "at_time": "10:00"}

    lst = (await owner.get(f"/ventures/{v}/custom-workflows")).json()
    assert lst["available"] is False and lst["items"] == []
    assert (await owner.post(f"/ventures/{v}/custom-workflows", json=body)).status_code == 402
    await _plan(org, "scale")
    assert (await viewer.post(f"/ventures/{v}/custom-workflows", json=body)).status_code == 403
    r = await owner.post(f"/ventures/{v}/custom-workflows", json=body)
    assert r.status_code == 201, r.text
    c = r.json()
    assert c["when"] == "An invoice is 3 day(s) overdue" and c["enabled"] is True
    nxt = datetime.fromisoformat(c["next_run_at"]).astimezone(IST)
    assert nxt.strftime("%H:%M") == "10:00" and nxt > datetime.now(IST)

    today = datetime.now(IST).date()
    await owner.post(f"/ventures/{v}/invoices", json={"customer_name": "Ravi", "customer_email": "ravi@example.com",
                                                              "amount_paise": 450000, "due_on": str(today - timedelta(days=5))})
    await owner.post(f"/ventures/{v}/invoices", json={"customer_name": "Not yet", "customer_email": "ny@example.com",
                                                      "amount_paise": 100000, "due_on": str(today - timedelta(days=1))})
    fake_llm.on("Follow the owner's instructions exactly", lambda m: {
        "subject": "About invoice", "body": "Hi Ravi, ₹4,500 is still due; happy to split it in two." if "₹4,500" in str(m) else "no facts"})

    # the worker's daily check at 10:00 finds the one late invoice, once
    assert await cw.fire_due(services, nxt.astimezone(UTC) + timedelta(seconds=20)) == 1
    aps = [a for a in (await owner.get(f"/ventures/{v}/approvals")).json() if a["agent"] == "custom"]
    assert len(aps) == 1 and aps[0]["payload"]["to"] == "ravi@example.com" and "split it in two" in aps[0]["payload"]["body"]
    assert aps[0]["status"] == "pending"
    run = await owner.post(f"/ventures/{v}/custom-workflows/{c['id']}/run")
    assert run.status_code == 201
    assert len([a for a in (await owner.get(f"/ventures/{v}/approvals")).json() if a["agent"] == "custom"]) == 1

    # notify: a note to the maker about each new lead
    await owner.post(f"/ventures/{v}/leads", json={"name": "Asha", "email": "asha@example.com"})
    n = (await owner.post(f"/ventures/{v}/custom-workflows", json={**body, "name": "Call new leads", "trigger": "lead_new",
                                                                   "wait_days": 0, "action": "notify",
                                                                   "instructions": "Tell me who to call and what to say"})).json()
    fake_llm.on("Write a short note to the owner", {"subject": "Call Asha", "body": "Asha came in today; call her."})
    outbox = get_mailer().outbox
    before = len(outbox)
    assert (await owner.post(f"/ventures/{v}/custom-workflows/{n['id']}/run")).status_code == 201
    mine = [m for m in outbox[before:] if m["To"] == owner.email]
    assert len(mine) == 1 and mine[0]["Subject"] == "Call new leads: Call Asha"

    # off, changes, delete; a plan without custom workflows can't switch it back on
    off = await owner.patch(f"/ventures/{v}/custom-workflows/{c['id']}", json={"enabled": False, "wait_days": 7})
    assert off.json()["enabled"] is False and off.json()["when"] == "An invoice is 7 day(s) overdue"
    await _plan(org, "growth")
    assert (await owner.patch(f"/ventures/{v}/custom-workflows/{c['id']}", json={"enabled": True})).status_code == 402
    assert (await owner.post(f"/ventures/{v}/custom-workflows/{n['id']}/run")).status_code == 402
    assert (await owner.delete(f"/ventures/{v}/custom-workflows/{c['id']}")).status_code == 204
    assert (await make_actor(client, "cw-stranger")).id   # a stranger sees nothing
    stranger = await make_actor(client, "cw-stranger2")
    assert (await stranger.get(f"/ventures/{v}/custom-workflows")).status_code == 404


async def test_every_trigger_query_runs(world):
    from kritvia_api.db.session import tenant_tx
    from kritvia_api.services import custom_workflows as cw
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures", json={"name": "Trig", "slug": f"t-{uuid.uuid4().hex[:6]}"})).json()["id"]
    async with tenant_tx(mayank.id) as conn:
        for t in cw.TRIGGERS:
            for email_only in (True, False):
                assert await cw.candidates(conn, uuid.UUID(v), t, 2, email_only) == []
            assert cw.describe(t, 0) and cw.describe(t, 5)
