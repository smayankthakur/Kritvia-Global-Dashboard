"""Prospector: find businesses without a website on Google Maps, message them, follow up, stop on a reply
or an opt-out; replies are answered by the inbox assistant."""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from kritvia_api.plans import PLANS
from kritvia_api.services.google import GoogleClient
from kritvia_api.services.places import PlacesClient, PlacesError, website_kind
from kritvia_api.workflows.prospector import area_of, is_opt_out, norm_phone, whatsapp_link



def place(pid, name, *, phone="+91 98737 78861", website=None, rating=4.2, reviews=500, status="OPERATIONAL"):
    p = {"id": pid, "displayName": {"text": name}, "businessStatus": status, "rating": rating,
         "userRatingCount": reviews, "formattedAddress": "Shop 4, Shivram Park, Nangloi, Delhi 110041",
         "primaryTypeDisplayName": {"text": "North Indian restaurant"},
         "googleMapsUri": f"https://maps.google.com/?cid={pid}"}
    if phone:
        p["internationalPhoneNumber"] = phone
    if website:
        p["websiteUri"] = website
    return p


PAGE1 = [
    place("pA", "Ramesh Dhaba", phone="+91 98737 78861", reviews=1700),
    place("pB", "Has A Site", phone="+91 98000 00002", website="https://hasasite.in"),
    place("pC", "Insta Cafe", phone="+91 98000 00003", website="https://www.instagram.com/instacafe", reviews=50),
    place("pD", "Gone Restaurant", phone="+91 98000 00004", status="CLOSED_PERMANENTLY"),
]
PAGE2 = [
    place("pE", "No Phone Kitchen", phone=None),
    place("pF", "Too New", phone="+91 98000 00006", reviews=5),
    place("pG", "Low Rated", phone="+91 98000 00007", rating=2.9),
    place("pH", "Swiggy Only", phone="098000 00008", website="https://www.swiggy.com/restaurants/x", reviews=30),
]


class FakePlaces:
    def __init__(self, pages=(PAGE1, PAGE2)):
        self.pages, self.calls, self.lookups, self.closed = list(pages), [], [], {}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.method == "GET":     # place details by ID
            pid = request.url.path.rsplit("/", 1)[1]
            self.lookups.append({"id": pid, "mask": request.headers.get("X-Goog-FieldMask")})
            for page in self.pages:
                for p in page:
                    if p["id"] == pid:
                        if self.closed.get(pid):
                            p = {**p, "businessStatus": "CLOSED_PERMANENTLY"}
                        return httpx.Response(200, json=p)
            return httpx.Response(404, json={"error": {"message": "Place not found"}})
        body = json.loads(request.content)
        self.calls.append({"body": body, "key": request.headers.get("X-Goog-Api-Key"),
                           "mask": request.headers.get("X-Goog-FieldMask")})
        i = int(body.get("pageToken") or 0)
        out: dict = {"places": self.pages[i]}
        if i + 1 < len(self.pages):
            out["nextPageToken"] = str(i + 1)
        return httpx.Response(200, json=out)


def script_outreach(fake, *, email_body="Namaste, I found you on Google Maps. A website would bring orders directly.",
                    whatsapp="Namaste! Google Maps pe aapka dhaba dekha. Website se direct orders aa sakte hain."):
    fake.on("You write short, honest sales messages", {
        "subject": "Orders without Swiggy commission", "email_body": email_body, "whatsapp": whatsapp})


@pytest.fixture
def places(services, monkeypatch):
    fake = FakePlaces()
    monkeypatch.setattr(services, "places", PlacesClient("test-key", transport=httpx.MockTransport(fake)))
    return fake


@pytest.fixture
async def biz(world, client):
    """A fresh 'software' business (Sitelytc-like) with the Prospector on."""
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Studio", "slug": f"studio-{uuid.uuid4().hex[:6]}"})).json()["id"]
    await mayank.put(f"/ventures/{v}/settings", json={"kind": "software", "business_name": "Sitelytc", "city": "Delhi"})
    r = await mayank.put(f"/ventures/{v}/workflow-configs/prospector", json={"enabled": True, "settings": {
        "searches": "restaurants in Nangloi, Delhi", "offer": "a website with online ordering for ₹9,999"}})
    assert r.status_code == 200, r.text
    return {**world, "v": v}


async def run(actor, v, inp=None):
    r = await actor.post(f"/ventures/{v}/runs", json={"workflow": "prospector", "input": inp or {}})
    assert r.status_code == 201, r.text
    return (await actor.get(f"/ventures/{v}/runs/{r.json()['id']}")).json()


async def leads(actor, v):
    """Leads by the name Google Maps shows (looked up live), or the stored name for anyone else."""
    got = (await actor.get(f"/ventures/{v}/leads?limit=200&live=true")).json()
    return {(x["place"] or {}).get("name") or x["name"]: x for x in got}


# ----------------------------------------------------------------------------------- helpers --
def test_website_kind():
    assert website_kind(None) == "none" and website_kind("") == "none"
    assert website_kind("https://www.instagram.com/x") == "social"
    assert website_kind("linktr.ee/x") == "social"
    assert website_kind("https://www.swiggy.com/restaurants/x") == "listing"
    assert website_kind("https://zoma.to/abc") == "listing"
    assert website_kind("https://ramesh-dhaba.in") == "own"
    assert website_kind("https://notinstagram.com") == "own"


def test_phone_and_links():
    assert norm_phone("+91 98737 78861") == "+919873778861"
    assert norm_phone("098737 78861") == "+919873778861"
    assert norm_phone("919873778861") == "+919873778861"
    assert norm_phone("011 2345") is None
    assert norm_phone("+44 20 7946 0958") == "+442079460958"
    assert whatsapp_link("098737 78861", "Hi there") == "https://wa.me/919873778861?text=Hi%20there"
    assert area_of("Shop 4, Shivram Park, Nangloi, Delhi 110041") == "Nangloi"


def test_opt_out_phrases():
    for no in ("STOP", "stop please", "Unsubscribe", "Not interested, thanks", "please don't message again",
               "Bhai mat bhejo", "nahi chahiye", "No"):
        assert is_opt_out(no), no
    for yes in ("Haan, details bhejo", "We never stop working, what's the price?", "Tell me more",
                "No problem, call me at 5"):
        assert not is_opt_out(yes), yes


def test_only_full_plans_include_the_prospector():
    assert not PLANS["starter"].allows_agent("prospector", "software")
    assert PLANS["growth"].allows_agent("prospector", "software")
    assert PLANS["internal"].allows_agent("prospector", "software")


async def test_places_client_pages_and_errors():
    fake = FakePlaces()
    found = await PlacesClient("k", transport=httpx.MockTransport(fake)).search("restaurants in Nangloi")
    assert [p.place_id for p in found] == ["pA", "pB", "pC", "pD", "pE", "pF", "pG", "pH"]
    assert fake.calls[0]["key"] == "k" and "places.websiteUri" in fake.calls[0]["mask"]
    assert fake.calls[1]["body"]["pageToken"] == "1" and fake.calls[0]["body"]["regionCode"] == "IN"
    assert found[2].website_kind == "social" and found[0].phone == "+91 98737 78861"
    with pytest.raises(PlacesError):
        await PlacesClient("").search("x")
    bad = PlacesClient("k", transport=httpx.MockTransport(
        lambda r: httpx.Response(403, json={"error": {"message": "API key not valid"}})))
    with pytest.raises(PlacesError, match="403: API key not valid"):
        await bad.search("x")


async def test_gmail_send_returns_thread():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"id": "m-9", "threadId": "t-9"})
    g = GoogleClient("c", "s", "http://x", transport=httpx.MockTransport(handler))
    assert await g.send_email("tok", to="a@b.co", subject="s", body="b") == {"id": "m-9", "thread_id": "t-9"}


# --------------------------------------------------------------------------------- the agent --
async def test_not_set_up_without_a_places_key(biz, fake_llm):
    r = await run(biz["mayank"], biz["v"])
    assert r["status"] == "completed" and r["summary"]["reason"] == "places_not_set_up"


async def test_finds_businesses_without_a_website_and_drafts_whatsapp(biz, places, fake_llm):
    mayank, v = biz["mayank"], biz["v"]
    script_outreach(fake_llm)
    r = await run(mayank, v)
    assert r["status"] == "completed" and r["outcome"] == "prospected", r
    assert r["summary"]["found"] == 8 and r["summary"]["added"] == 3 and r["summary"]["touches"] == 3
    got = await leads(mayank, v)
    # no own website, open, has a phone, enough reviews, rated 3.5+ (Instagram and Swiggy pages count as none)
    assert set(got) == {"Ramesh Dhaba", "Insta Cafe", "Swiggy Only"}
    a = got["Ramesh Dhaba"]
    # Google's terms: only the place ID is stored; the name, phone and the rest are looked up live
    assert a["source"] == "prospector" and a["place_id"] == "pA" and a["website_kind"] == "none"
    assert a["name"] == "Business on Google Maps" and a["phone"] is None and a["company"] is None
    assert a["place_search"] == "restaurants in Nangloi, Delhi"
    assert a["status"] == "new" and a["outreach_step"] == 0 and a["next_touch_at"] is None
    assert a["outreach_draft"].startswith("Namaste!") and "Reply STOP" in a["outreach_draft"]
    assert places.lookups[-1]["mask"] == "id,displayName"          # the list asks only for names
    one = (await mayank.get(f"/ventures/{v}/leads/{a['id']}")).json()
    assert one["place"]["phone"] == "+91 98737 78861" and one["place"]["review_count"] == 1700
    assert "nationalPhoneNumber" in places.lookups[-1]["mask"]
    assert one["whatsapp_link"].startswith("https://wa.me/919873778861?text=Namaste")
    assert got["Swiggy Only"]["website_kind"] == "listing" and got["Insta Cafe"]["website_kind"] == "social"
    # nothing from Google sits in the lead row, the run state or the run notes
    run_detail = json.dumps((await mayank.get(f"/ventures/{v}/runs/{r['id']}")).json(), ensure_ascii=False)
    assert "Ramesh" not in run_detail and "98737" not in run_detail
    # the model was told the facts and the offer, and that this is a first message
    prompt = fake_llm.chat_calls("You write short, honest sales messages")[0]
    text_ = json.dumps(prompt, ensure_ascii=False)
    assert "FIRST message" in text_ and "1700 reviews" in text_ and "₹9,999" in text_ and "Nangloi" in text_

    # the next day: nobody is added twice, and drafts waiting for the owner are not rewritten
    r2 = await run(mayank, v)
    assert r2["summary"]["added"] == 0 and r2["summary"]["touches"] == 0


async def test_daily_cap(biz, places, fake_llm, world):
    mayank, v = biz["mayank"], biz["v"]
    await mayank.put(f"/ventures/{v}/workflow-configs/prospector", json={"enabled": True, "settings": {
        "searches": "restaurants in Nangloi, Delhi", "new_per_day": 2}})
    script_outreach(fake_llm)
    assert (await run(mayank, v))["summary"]["added"] == 2
    assert (await run(mayank, v))["summary"]["reason"] == "daily_cap"
    # the busiest places come first
    assert set(await leads(mayank, v)) == {"Ramesh Dhaba", "Insta Cafe"}


async def test_whatsapp_sent_then_follow_up_then_sequence_ends(biz, places, fake_llm):
    mayank, v = biz["mayank"], biz["v"]
    await mayank.put(f"/ventures/{v}/workflow-configs/prospector", json={"enabled": True, "settings": {
        "searches": "restaurants in Nangloi, Delhi", "followups": 1, "follow_up_days": 3}})
    script_outreach(fake_llm)
    await run(mayank, v)
    lead = (await leads(mayank, v))["Ramesh Dhaba"]
    url = f"/ventures/{v}/leads/{lead['id']}/outreach"

    r = await mayank.post(url, json={"action": "whatsapp_sent"})
    assert r.status_code == 200, r.text
    a = r.json()
    assert a["status"] == "contacted" and a["outreach_step"] == 1 and a["last_touch_channel"] == "whatsapp"
    assert a["outreach_draft"] is None
    due = datetime.fromisoformat(a["next_touch_at"])
    assert timedelta(days=2.9) < due - datetime.now(timezone.utc) < timedelta(days=3.1)

    # pretend three days passed
    assert (await mayank.post(url, json={"action": "resume"})).status_code == 200
    r = await run(mayank, v)
    assert r["summary"]["touches"] == 1
    a = (await mayank.get(f"/ventures/{v}/leads/{lead['id']}")).json()
    assert a["outreach_draft"] and "follow-up number 1" in json.dumps(fake_llm.chat_calls(
        "You write short, honest sales messages")[-1]) and "LAST message" in json.dumps(
        fake_llm.chat_calls("You write short, honest sales messages")[-1])

    a = (await mayank.post(url, json={"action": "called"})).json()
    assert a["outreach_step"] == 2 and a["last_touch_channel"] == "call" and a["next_touch_at"] is None  # done


async def test_email_goes_out_by_itself_and_follow_up_threads(biz, places, fake_llm):
    mayank, v = biz["mayank"], biz["v"]
    script_outreach(fake_llm)
    await run(mayank, v)
    lead = (await leads(mayank, v))["Ramesh Dhaba"]
    # the owner found their email: from now on the agent writes by email
    r = await mayank.patch(f"/ventures/{v}/leads/{lead['id']}", json={"email": "Ramesh@Example.com"})
    assert r.status_code == 200 and r.json()["email"] == "ramesh@example.com"
    await mayank.post(f"/ventures/{v}/leads/{lead['id']}/outreach", json={"action": "resume"})
    r = await run(mayank, v)
    touch = [x for x in (await mayank.get(f"/ventures/{v}/runs?workflow=prospector")).json()
             if x["outcome"] == "emailed"]
    assert len(touch) == 1 and touch[0]["pending_approvals"] == 0          # sent without asking
    detail = (await mayank.get(f"/ventures/{v}/runs/{touch[0]['id']}")).json()
    assert [s["step"] for s in detail["steps"]][-2:] == ["draft", "sent"]
    a = (await mayank.get(f"/ventures/{v}/leads/{lead['id']}")).json()
    assert a["status"] == "contacted" and a["outreach_step"] == 1 and a["last_touch_channel"] == "email"
    assert a["next_touch_at"] is not None
    assert a["outreach_draft"] is None          # the WhatsApp draft from before the email was found is gone


async def test_owner_can_require_approval_and_price_guesses_always_wait(biz, places, fake_llm, client):
    from conftest import join, make_actor
    mayank, v = biz["mayank"], biz["v"]
    approver = await make_actor(client, "pros-approver")
    await join(mayank, approver, biz["org"], v, "approver")
    await mayank.put(f"/ventures/{v}/workflow-configs/prospector", json={"enabled": True, "settings": {
        "searches": "restaurants in Nangloi, Delhi", "offer": "a website with online ordering for ₹9,999",
        "new_per_day": 1}})
    # the model makes up a price: even with "send without asking" on, a person must look
    script_outreach(fake_llm, email_body="A website for just ₹25,000 would bring direct orders.")
    await run(mayank, v)
    lead = (await leads(mayank, v))["Ramesh Dhaba"]
    await mayank.patch(f"/ventures/{v}/leads/{lead['id']}", json={"email": "ramesh@example.com"})
    await mayank.post(f"/ventures/{v}/leads/{lead['id']}/outreach", json={"action": "resume"})
    await run(mayank, v)
    waiting = [x for x in (await mayank.get(f"/ventures/{v}/runs?workflow=prospector")).json()
               if x["status"] == "waiting"]
    assert len(waiting) == 1
    a = [x for x in (await approver.get("/approvals/inbox")).json() if x["run_id"] == waiting[0]["id"]][0]
    assert "₹25,000" in a["summary"] and "isn't in your offer" in a["summary"]
    # rejecting it leaves the prospect alone until the owner decides
    r = await approver.post(f"/ventures/{v}/approvals/{a['id']}/decision", json={"decision": "reject"})
    assert r.status_code == 200, r.text
    lead = (await mayank.get(f"/ventures/{v}/leads/{lead['id']}")).json()
    assert lead["next_touch_at"] is None and lead["outreach_step"] == 0


async def test_email_reply_stops_the_sequence_and_is_answered(biz, places, fake_llm):
    mayank, v = biz["mayank"], biz["v"]
    await mayank.put(f"/ventures/{v}/workflow-configs/inbox_assistant", json={"enabled": True, "settings": {}})
    script_outreach(fake_llm)
    await run(mayank, v)
    lead = (await leads(mayank, v))["Ramesh Dhaba"]
    await mayank.patch(f"/ventures/{v}/leads/{lead['id']}", json={"email": "ramesh@example.com"})
    await mayank.post(f"/ventures/{v}/leads/{lead['id']}/outreach", json={"action": "whatsapp_sent"})

    fake_llm.on("You sort the business's incoming messages", {
        "category": "support", "summary": "The dhaba owner wants details.", "needs_reply": True,
        "language": "hinglish", "urgency": "medium"})
    fake_llm.on("You answer the business's", {"subject": "Re: website", "body": "Ji zaroor! Kal 5 baje call karein?",
                                               "used_sources": [], "unsure": False})
    r = await mayank.post(f"/ventures/{v}/runs", json={"workflow": "inbox_assistant", "input": {
        "channel": "email", "from_name": "Ramesh", "from_email": "Ramesh@Example.com", "subject": "Re: website",
        "body": "Haan ji, details bhejo", "message_id": "m-reply-1", "thread_id": "t-unknown"}})
    reply = (await mayank.get(f"/ventures/{v}/runs/{r.json()['id']}")).json()
    assert reply["outcome"] == "replied" and reply["summary"]["prospect"] is True     # answered without asking
    prompt = json.dumps(fake_llm.chat_calls("You answer the business's")[-1], ensure_ascii=False)
    assert "replying to a message we sent them first" in prompt and "₹9,999" in prompt
    a = (await mayank.get(f"/ventures/{v}/leads/{lead['id']}")).json()
    assert a["status"] == "replied" and a["replied_at"] and a["next_touch_at"] is None
    assert (await mayank.post(f"/ventures/{v}/leads/{lead['id']}/outreach",
                              json={"action": "resume"})).status_code == 409


async def test_unsure_reply_to_a_prospect_waits(biz, places, fake_llm):
    mayank, v = biz["mayank"], biz["v"]
    await mayank.put(f"/ventures/{v}/workflow-configs/inbox_assistant", json={"enabled": True, "settings": {}})
    script_outreach(fake_llm)
    await run(mayank, v)
    lead = (await leads(mayank, v))["Ramesh Dhaba"]
    await mayank.patch(f"/ventures/{v}/leads/{lead['id']}", json={"email": "ramesh@example.com"})
    fake_llm.on("You sort the business's incoming messages", {
        "category": "support", "summary": "Asks for a price.", "needs_reply": True, "language": "en", "urgency": "medium"})
    fake_llm.on("You answer the business's", {"subject": "Re: website", "body": "It costs ₹40,000 all in.",
                                               "used_sources": [], "unsure": False})
    r = await mayank.post(f"/ventures/{v}/runs", json={"workflow": "inbox_assistant", "input": {
        "channel": "email", "from_name": "Ramesh", "from_email": "ramesh@example.com", "subject": "Re: website",
        "body": "How much?", "message_id": "m-reply-2"}})
    out = (await mayank.get(f"/ventures/{v}/runs/{r.json()['id']}")).json()
    assert out["status"] == "waiting" and out["pending_approvals"] == 1     # a price not in the offer


async def test_owner_marks_a_whatsapp_reply_and_saves_their_details(biz, places, fake_llm):
    mayank, v = biz["mayank"], biz["v"]
    script_outreach(fake_llm)
    await run(mayank, v)
    lead = (await leads(mayank, v))["Ramesh Dhaba"]
    url = f"/ventures/{v}/leads/{lead['id']}"
    await mayank.post(f"{url}/outreach", json={"action": "whatsapp_sent"})
    a = (await mayank.post(f"{url}/outreach", json={"action": "replied"})).json()
    assert a["status"] == "replied" and a["replied_at"] and a["next_touch_at"] is None
    # the details they gave the owner are the owner's to keep
    a = (await mayank.patch(url, json={"name": "Ramesh Kumar", "phone": "098737 78861"})).json()
    assert a["name"] == "Ramesh Kumar" and a["phone"] == "+919873778861"
    assert (await mayank.patch(url, json={"name": "   "})).json()["name"] == "Ramesh Kumar"


async def test_closed_or_unknown_places_are_dropped(biz, places, fake_llm):
    mayank, v = biz["mayank"], biz["v"]
    script_outreach(fake_llm)
    await run(mayank, v)
    lead = (await leads(mayank, v))["Ramesh Dhaba"]
    url = f"/ventures/{v}/leads/{lead['id']}"
    await mayank.post(f"{url}/outreach", json={"action": "whatsapp_sent"})
    places.closed["pA"] = True
    await mayank.post(f"{url}/outreach", json={"action": "resume"})
    await run(mayank, v)
    a = (await mayank.get(url)).json()
    assert a["status"] == "archived" and a["next_touch_at"] is None


async def test_opt_out_is_final(biz, places, fake_llm):
    mayank, v = biz["mayank"], biz["v"]
    await mayank.put(f"/ventures/{v}/workflow-configs/inbox_assistant", json={"enabled": True, "settings": {}})
    script_outreach(fake_llm)
    await run(mayank, v)
    lead = (await leads(mayank, v))["Ramesh Dhaba"]
    await mayank.patch(f"/ventures/{v}/leads/{lead['id']}", json={"email": "ramesh@example.com"})
    r = await mayank.post(f"/ventures/{v}/runs", json={"workflow": "inbox_assistant", "input": {
        "channel": "email", "from_name": "Ramesh", "from_email": "RAMESH@example.com", "subject": "Re: website",
        "body": "Not interested, please don't email again.", "message_id": "m-optout"}})
    out = (await mayank.get(f"/ventures/{v}/runs/{r.json()['id']}")).json()
    assert out["outcome"] == "opted_out"
    assert not fake_llm.chat_calls("You sort the business's incoming messages")   # no reply, no AI
    a = (await mayank.get(f"/ventures/{v}/leads/{lead['id']}")).json()
    assert a["opted_out_at"] and a["status"] == "lost" and a["whatsapp_link"] is None and a["outreach_draft"] is None
    assert (await mayank.post(f"/ventures/{v}/leads/{lead['id']}/outreach",
                              json={"action": "whatsapp_sent"})).status_code == 409
    # and the agent never picks them up again
    assert (await run(mayank, v))["summary"]["touches"] == 0


async def test_viewer_cannot_log_outreach(biz, places, fake_llm, client):
    from conftest import join, make_actor
    mayank, v = biz["mayank"], biz["v"]
    script_outreach(fake_llm)
    await run(mayank, v)
    lead = (await leads(mayank, v))["Ramesh Dhaba"]
    viewer = await make_actor(client, "pros-viewer")
    await join(mayank, viewer, biz["org"], v, "viewer")
    r = await viewer.post(f"/ventures/{v}/leads/{lead['id']}/outreach", json={"action": "opt_out"})
    assert r.status_code in (403, 404)
    assert (await mayank.get(f"/ventures/{v}/leads/{lead['id']}")).json()["opted_out_at"] is None


async def test_send_without_asking_off_means_every_email_waits(biz, places, fake_llm):
    mayank, v = biz["mayank"], biz["v"]
    await mayank.put(f"/ventures/{v}/workflow-configs/prospector", json={"enabled": True, "settings": {
        "searches": "restaurants in Nangloi, Delhi", "new_per_day": 1, "send_without_asking": False}})
    trust = {(t["agent"], t["action"]): t["auto_run"] for t in (await mayank.get(f"/ventures/{v}/trust")).json()}
    assert trust.get(("prospector", "gmail.send")) is False
    script_outreach(fake_llm)
    await run(mayank, v)
    lead = (await leads(mayank, v))["Ramesh Dhaba"]
    await mayank.patch(f"/ventures/{v}/leads/{lead['id']}", json={"email": "ramesh@example.com"})
    await mayank.post(f"/ventures/{v}/leads/{lead['id']}/outreach", json={"action": "resume"})
    await run(mayank, v)
    runs = (await mayank.get(f"/ventures/{v}/runs?workflow=prospector")).json()
    assert [x["status"] for x in runs if x["pending_approvals"]] == ["waiting"]


async def test_switch_grants_only_the_prospectors_own_trust(biz):
    mayank, v = biz["mayank"], biz["v"]
    trust = {(t["agent"], t["action"]): t["auto_run"] for t in (await mayank.get(f"/ventures/{v}/trust")).json()}
    assert trust[("prospector", "gmail.send")] and trust[("prospector", "whatsapp.send")]
    assert not any(auto for (agent, _), auto in trust.items() if agent != "prospector")
    # turning the agent off withdraws it
    await mayank.put(f"/ventures/{v}/workflow-configs/prospector", json={"enabled": False, "settings": {}})
    trust = {(t["agent"], t["action"]): t["auto_run"] for t in (await mayank.get(f"/ventures/{v}/trust")).json()}
    assert not trust[("prospector", "gmail.send")]
