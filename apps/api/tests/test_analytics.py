"""Analytics: basic for every plan (30/90 days, compared with the period before, trend); advanced on
Growth and above (up to a year, funnel, ageing, agents, channels, AI, top customers)."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta
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
        await conn.execute("INSERT INTO org_plans (org_id, plan) VALUES ($1, $2)"
                           " ON CONFLICT (org_id) DO UPDATE SET plan = $2", uuid.UUID(org), plan)
    finally:
        await conn.close()


async def test_basic_then_advanced(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "default_plan", "free")
    owner = await make_actor(client, "an-owner")
    org = (await owner.post("/orgs", json={"name": "Numbers Co", "slug": f"an-{uuid.uuid4().hex[:8]}"})).json()["id"]
    v = (await owner.post(f"/orgs/{org}/ventures", json={"name": "Shop", "slug": f"an-{uuid.uuid4().hex[:6]}"})).json()["id"]
    today = datetime.now(IST).date()
    a = (await owner.post(f"/ventures/{v}/invoices", json={"customer_name": "Kapoor Sweets", "amount_paise": 500000,
                                                           "due_on": str(today)})).json()
    await owner.post(f"/ventures/{v}/invoices/{a['id']}/payment", json={"amount_paise": 500000})
    await owner.post(f"/ventures/{v}/invoices", json={"customer_name": "Late Ltd", "amount_paise": 300000,
                                                      "due_on": str(today - timedelta(days=40))})
    await owner.post(f"/ventures/{v}/leads", json={"name": "Asha", "email": "asha@example.com"})

    r = await owner.get(f"/ventures/{v}/analytics?days=30")
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["level"] == "basic" and d["upgrade_to"] == "Growth" and d["advanced"] is None and d["bucket"] == "day"
    assert d["current"]["received_paise"] == 500000 and d["current"]["invoices_issued"] == 2
    assert d["current"]["outstanding_paise"] == 300000 and d["current"]["overdue_paise"] == 300000
    assert d["current"]["new_leads"] == 1 and d["previous"]["received_paise"] == 0
    assert len(d["trend"]) in (30, 31) and sum(t["received_paise"] for t in d["trend"]) == 500000
    assert (await owner.get(f"/ventures/{v}/analytics?days=90")).json()["bucket"] == "week"
    assert (await owner.get(f"/ventures/{v}/analytics?days=365")).status_code == 402
    assert (await owner.get(f"/ventures/{v}/analytics?days=12")).status_code == 422

    await _plan(org, "growth")
    d = (await owner.get(f"/ventures/{v}/analytics?days=365")).json()
    assert d["level"] == "advanced" and d["bucket"] == "month"
    adv = d["advanced"]
    assert adv["funnel"]["new"] == 1
    assert adv["ageing"]["d31_60"] == 300000 and adv["ageing"]["not_due"] == 0
    assert adv["top_customers"][0] == {"customer": "Kapoor Sweets", "received_paise": 500000, "payments": 1}

    # another business's people see nothing
    stranger = await make_actor(client, "an-stranger")
    assert (await stranger.get(f"/ventures/{v}/analytics")).status_code == 404
    viewer = await make_actor(client, "an-viewer")
    await join(owner, viewer, org, v, "viewer")
    assert (await viewer.get(f"/ventures/{v}/analytics")).status_code == 200
