"""Phase 1, Unstick: the Prospector emails businesses that have a website by itself (email first), Kritvia
checks its own agents every morning and tells the owner what is stuck, and drafts about to expire are nudged."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import asyncpg
import httpx
import pytest

from conftest import ADMIN_DSN
from kritvia_api.services import contact_email, self_check
from kritvia_api.services.mailer import get_mailer
from kritvia_api.services.places import PlacesClient
from test_prospector import FakePlaces, leads, run, script_outreach

SITE = {
    "https://hasasite.in": ('<html><a href="/about">About</a> <a href="/contact-us">Contact us</a>'
                            '<img src="logo@2x.png"></html>'),
    "https://hasasite.in/contact-us": ('<p>Write to <a href="mailto:Info@HasASite.in?subject=Hi">us</a> or '
                                       'owner.name@gmail.com. Built by someone@wixpress.com</p>'),
}


def site_transport(pages: dict[str, str]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url).rstrip("/")
        if url in pages:
            return httpx.Response(200, html=pages[url])
        return httpx.Response(404, text="nope")
    return httpx.MockTransport(handler)


@pytest.fixture
def web(monkeypatch):
    async def public_ip(host):
        return ["93.184.216.34"]
    monkeypatch.setattr(contact_email, "resolve", public_ip)
    monkeypatch.setattr(contact_email, "_transport", site_transport(SITE))


# ----------------------------------------------------------------------------- contact emails --
def test_picks_the_business_own_address():
    found = contact_email.candidates(SITE["https://hasasite.in/contact-us"])
    assert "someone@wixpress.com" not in found and "info@hasasite.in" in found
    assert contact_email.best(found, "hasasite.in") == "info@hasasite.in"
    assert contact_email.best(["owner.name@gmail.com"], "hasasite.in") == "owner.name@gmail.com"
    assert contact_email.best(["sales@other-company.com"], "hasasite.in") is None   # someone else's domain
    assert contact_email.candidates('<img src="hero@2x.png"> noreply@hasasite.in') == []


async def test_reads_the_contact_page_and_refuses_private_addresses(web, monkeypatch):
    assert await contact_email.find("https://hasasite.in") == "info@hasasite.in"
    assert await contact_email.find(None) is None

    async def private_ip(host):
        return ["10.0.0.5"]
    monkeypatch.setattr(contact_email, "resolve", private_ip)
    assert await contact_email.find("https://hasasite.in") is None
    assert await contact_email.find("ftp://hasasite.in") is None


# ------------------------------------------------------------------------------- email first --
@pytest.fixture
def places(services, monkeypatch):
    fake = FakePlaces()
    monkeypatch.setattr(services, "places", PlacesClient("test-key", transport=httpx.MockTransport(fake)))
    return fake


@pytest.fixture
async def biz(world, client):
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Studio", "slug": f"studio-{uuid.uuid4().hex[:6]}"})).json()["id"]
    name = f"Unstick {uuid.uuid4().hex[:6]}"
    await mayank.put(f"/ventures/{v}/settings", json={"kind": "software", "business_name": name, "city": "Delhi"})
    return {**world, "v": v, "name": name}


async def test_businesses_with_a_website_are_emailed_first_and_by_themselves(biz, places, web, fake_llm):
    mayank, v = biz["mayank"], biz["v"]
    r = await mayank.put(f"/ventures/{v}/workflow-configs/prospector", json={"enabled": True, "settings": {
        "searches": "restaurants in Nangloi, Delhi", "offer": "a website with online ordering for ₹9,999",
        "email_offer": "an AI assistant that answers your enquiries on WhatsApp", "new_per_day": 2}})
    assert r.status_code == 200, r.text
    script_outreach(fake_llm)
    r = await run(mayank, v)
    assert r["summary"]["by_email"] == 1 and r["summary"]["added"] == 2, r["summary"]
    got = await leads(mayank, v)
    site = got["Has A Site"]
    # email first: the business with a website and an email takes the first of today's two places
    assert site["email"] == "info@hasasite.in" and site["website_kind"] == "own"
    assert set(got) == {"Has A Site", "Ramesh Dhaba"}
    runs = (await mayank.get(f"/ventures/{v}/runs?workflow=prospector")).json()
    emailed = [x for x in runs if x["outcome"] == "emailed"]
    assert len(emailed) == 1 and emailed[0]["pending_approvals"] == 0          # went out by itself
    assert {x["outcome"] for x in runs} >= {"emailed", "whatsapp_ready"}
    # it was written about the other offer, not a website
    prompts = [c["prompt"] for c in fake_llm.chat_calls("You write short, honest sales messages")]
    site_prompt = next(p for p in prompts if "their own website" in p)
    assert "an AI assistant that answers your enquiries" in site_prompt and "₹9,999" not in site_prompt
    # the website address from Google is not stored anywhere
    assert "hasasite.in/" not in str(got) and site["notes"] in (None, "")


async def test_without_an_email_offer_websites_are_still_skipped(biz, places, web, fake_llm):
    mayank, v = biz["mayank"], biz["v"]
    await mayank.put(f"/ventures/{v}/workflow-configs/prospector", json={"enabled": True, "settings": {
        "searches": "restaurants in Nangloi, Delhi"}})
    script_outreach(fake_llm)
    r = await run(mayank, v)
    assert r["summary"]["by_email"] == 0
    assert "Has A Site" not in await leads(mayank, v)


# -------------------------------------------------------------------------- morning self-check --
def mail_to(subject_part: str) -> list:
    return [m for m in get_mailer().outbox if subject_part in m["Subject"]]


async def test_the_owner_is_told_what_is_stuck_once(biz, services):
    mayank, v, name = biz["mayank"], biz["v"], biz["name"]
    # the inbox assistant on, with nothing connected to feed it
    await mayank.put(f"/ventures/{v}/workflow-configs/inbox_assistant", json={"enabled": True})
    before = len(mail_to(name))
    now = datetime.now(UTC)
    await self_check.morning(services, now)
    got = mail_to(name)
    assert len(got) == before + 1
    body = got[-1].get_content()
    assert "nothing feeds it" in body and f"/v/{v}/settings" in body
    assert got[-1]["To"] == mayank.email
    # the next morning, the same news isn't sent again
    await self_check.morning(services, now + timedelta(days=1))
    assert len(mail_to(name)) == before + 1
    # something new is
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        org = await conn.fetchval("SELECT org_id FROM ventures WHERE id = $1", uuid.UUID(v))
        await conn.execute("INSERT INTO workflow_configs (org_id, venture_id, workflow, enabled) VALUES ($1, $2, 'reviews', true)",
                           org, uuid.UUID(v))
    finally:
        await conn.close()
    await self_check.morning(services, now + timedelta(days=2))
    assert len(mail_to(name)) == before + 2
    assert "no time set" in mail_to(name)[-1].get_content()
    # and the check is kept for the business to see
    h = (await mayank.get(f"/ventures/{v}/automation-health?days=7")).json()
    assert {f["kind"] for f in h["findings"]} >= {"on_no_source", "on_no_time"}
    assert all(f["path"].startswith(f"/v/{v}/") for f in h["findings"])


async def test_drafts_about_to_expire_are_nudged_once(biz, places, fake_llm, services):
    mayank, v = biz["mayank"], biz["v"]
    await mayank.put(f"/ventures/{v}/workflow-configs/prospector", json={"enabled": True, "settings": {
        "searches": "restaurants in Nangloi, Delhi", "new_per_day": 1, "send_without_asking": False}})
    script_outreach(fake_llm)
    await run(mayank, v)
    lead = (await leads(mayank, v))["Ramesh Dhaba"]
    await mayank.patch(f"/ventures/{v}/leads/{lead['id']}", json={"email": "ramesh@example.com"})
    await mayank.post(f"/ventures/{v}/leads/{lead['id']}/outreach", json={"action": "resume"})
    await run(mayank, v)
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        n = await conn.execute("UPDATE approvals SET expires_at = now() + interval '2 hours'"
                               " WHERE venture_id = $1 AND status = 'pending'", uuid.UUID(v))
        assert n.endswith(" 1")
    finally:
        await conn.close()
    before = len(mail_to("Drafts about to expire"))
    assert await self_check.nudge(services) >= 1
    got = mail_to("Drafts about to expire")
    assert len(got) == before + 1 and "will expire in about 2 hours" in got[-1].get_content()
    assert await self_check.nudge(services) == 0          # told once
    h = (await mayank.get(f"/ventures/{v}/automation-health?days=7")).json()
    assert any(f["kind"] == "waiting_drafts" for f in h["findings"])
