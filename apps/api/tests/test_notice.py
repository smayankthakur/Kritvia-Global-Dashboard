"""A business's own DPDP notice: published once a privacy contact is named, linked in email replies."""
from __future__ import annotations

import uuid

import pytest

from test_inbox_assistant import SUPPORT_MAIL, script_inbox

pytestmark = pytest.mark.asyncio


async def test_notice_published_and_linked_in_replies(world, client, fake_llm):
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Notice Shop", "slug": f"ns-{uuid.uuid4().hex[:6]}"})).json()["id"]
    await mayank.put(f"/ventures/{v}/workflow-configs/inbox_assistant", json={"enabled": True, "settings": {}})
    # nothing is public until the business names a privacy contact
    assert (await client.get(f"/public/notice/{v}")).status_code == 404
    s = (await mayank.get(f"/ventures/{v}/settings")).json()
    assert s["notice_url"] is None and s["notice_in_replies"] is False

    bad = await mayank.put(f"/ventures/{v}/settings", json={"privacy_contact_email": "not-an-email"})
    assert bad.status_code == 422
    r = await mayank.put(f"/ventures/{v}/settings", json={
        "business_name": "Mehta Stores", "city": "Pune", "privacy_contact_name": "Ritu Mehta",
        "privacy_contact_email": "privacy@mehta.example", "notice_in_replies": True})
    assert r.status_code == 200 and r.json()["notice_url"].endswith(f"/n/{v}")

    pub = await client.get(f"/public/notice/{v}")
    assert pub.status_code == 200
    n = pub.json()
    assert n["business_name"] == "Mehta Stores" and n["contact_email"] == "privacy@mehta.example"
    assert n["workflows"] == ["inbox_assistant"] and n["city"] == "Pune"

    script_inbox(fake_llm)
    run = await mayank.post(f"/ventures/{v}/runs", json={"workflow": "inbox_assistant", "input": SUPPORT_MAIL})
    assert run.status_code == 201, run.text
    inbox = (await mayank.get("/approvals/inbox")).json()
    mine = [a for a in inbox if a["run_id"] == run.json()["id"]]
    assert mine and f"/n/{v}" in mine[0]["payload"]["body"] and "How Mehta Stores handles your information" in mine[0]["payload"]["body"]

    # an operator cannot change it
    other = await mayank.put(f"/ventures/{v}/settings", json={"notice_in_replies": False})
    assert other.json()["notice_in_replies"] is False
    assert (await world["alice"].put(f"/ventures/{v}/settings", json={"privacy_contact_email": ""})).status_code == 404
