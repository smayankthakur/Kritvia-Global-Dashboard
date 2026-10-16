"""First win: the steps from sign-up to the first approved draft (with a practice customer email whose
reply goes to the person who asked), and Kritvia's staff-only Pilot health view."""
from __future__ import annotations

import uuid

import pytest

from kritvia_api.config import get_settings
from conftest import join, make_actor
from test_whatsapp_front_door import script

pytestmark = pytest.mark.asyncio


async def test_steps_practice_draft_and_first_yes(world, client, fake_llm):
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Asha Tuition", "slug": f"asha-{uuid.uuid4().hex[:6]}"})).json()["id"]
    viewer = await make_actor(client, "fw-viewer")
    await join(mayank, viewer, world["org"], v, "viewer")
    fw = (await mayank.get(f"/ventures/{v}/first-win")).json()
    assert fw["total"] == 7 and fw["done"] == 0 and fw["won_at"] is None
    assert [s["id"] for s in fw["steps"]] == ["profile", "agent", "draft", "yes", "phone", "channel", "invoice"]
    assert (await world["mallory"].get(f"/ventures/{v}/first-win")).status_code == 404

    # practice needs the Inbox assistant on, and a role that can start agents
    assert (await mayank.post(f"/ventures/{v}/first-win/practice")).status_code == 409
    await mayank.put(f"/ventures/{v}/settings", json={"kind": "general", "business_name": "Asha Tuition", "city": "Indore"})
    assert (await mayank.put(f"/ventures/{v}/workflow-configs/inbox_assistant",
                             json={"enabled": True, "settings": {}, "instructions": ""})).status_code == 200
    assert (await viewer.post(f"/ventures/{v}/first-win/practice")).status_code == 403

    script(fake_llm, reply="Hi Priya! Yes, we're open on Saturday from 10. Fees start at ₹1,500 a month.")
    r = await mayank.post(f"/ventures/{v}/first-win/practice")
    assert r.status_code == 201, r.text
    assert r.json()["reply_to"] == mayank.email
    a = [x for x in (await mayank.get(f"/ventures/{v}/approvals")).json() if x["run_id"] == r.json()["run_id"]][0]
    assert a["payload"]["to"] == mayank.email and "Saturday" in a["payload"]["body"]
    fw = (await mayank.get(f"/ventures/{v}/first-win")).json()
    assert {s["id"]: s["done"] for s in fw["steps"]} == {"profile": True, "agent": True, "draft": True, "yes": False,
                                                          "phone": False, "channel": False, "invoice": False}

    assert (await mayank.post(f"/ventures/{v}/approvals/{a['id']}/decision", json={"decision": "approve"})).status_code == 200
    fw = (await mayank.get(f"/ventures/{v}/first-win")).json()
    assert fw["done"] == 4 and fw["won_at"] and fw["minutes_to_win"] >= 1


async def test_pilot_health_is_staff_only(world, client, monkeypatch):
    from kritvia_api.config import get_settings
    mayank = world["mayank"]
    assert (await mayank.get("/staff/pilots")).status_code == 404
    assert (await mayank.get("/me/access")).json()["is_staff"] is False
    monkeypatch.setattr(get_settings(), "staff_emails", f"someone@else.in, {mayank.email.upper()}")
    assert (await mayank.get("/me/access")).json()["is_staff"] is True
    r = await mayank.get("/staff/pilots")
    assert r.status_code == 200, r.text
    mine = next(p for p in r.json()["pilots"] if p["org_id"] == world["org"])
    assert mine["businesses"] >= 1 and mine["health"] in ("won", "getting_started", "stuck", "quiet")
    assert 0 <= mine["steps_done"] <= 6
    assert (await world["mallory"].get("/staff/pilots")).status_code == 404


def test_founder_is_staff_when_staff_emails_is_empty(monkeypatch):
    from kritvia_api.config import FOUNDER_EMAIL
    from kritvia_api.routers.first_win import is_staff

    monkeypatch.setattr(get_settings(), "staff_emails", "")
    assert is_staff(FOUNDER_EMAIL.upper())
    assert not is_staff("someone@else.in")
    monkeypatch.setattr(get_settings(), "staff_emails", "ops@sitelytc.com")
    assert not is_staff(FOUNDER_EMAIL)


def test_slack_redirect_defaults_to_the_web_app(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "slack_redirect_uri", "")
    monkeypatch.setattr(s, "public_web_url", "https://app.sitelytc.com/")
    assert s.slack_redirect == "https://app.sitelytc.com/api/oauth/slack/callback"
    monkeypatch.setattr(s, "slack_redirect_uri", "https://x.test/cb")
    assert s.slack_redirect == "https://x.test/cb"
