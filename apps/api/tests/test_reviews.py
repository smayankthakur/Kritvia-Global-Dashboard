"""Google reviews: the business's listing, reviews read live with reply drafts (only a hash of each review
is kept), low ratings flagged, and review requests after finished bookings and paid invoices."""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import httpx
import pytest

from conftest import join, make_actor

pytestmark = pytest.mark.asyncio
PLACE = "ChIJglowsalonPune01"


class FakeGoogle:
    def __init__(self) -> None:
        self.reviews = [
            {"name": f"places/{PLACE}/reviews/r1", "rating": 5, "text": {"text": "Loved my haircut, Priya was great!"},
             "authorAttribution": {"displayName": "Meera Joshi"}, "relativePublishTimeDescription": "a week ago"},
            {"name": f"places/{PLACE}/reviews/r2", "rating": 2, "text": {"text": "Waited 40 minutes past my slot."},
             "authorAttribution": {"displayName": "Rahul K"}, "relativePublishTimeDescription": "2 days ago"}]
        self.calls: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request.headers.get("x-goog-fieldmask", ""))
        if request.url.path.endswith(":searchText"):
            return httpx.Response(200, json={"places": [{"id": PLACE, "displayName": {"text": "Glow Salon"},
                                                         "formattedAddress": "FC Road, Pune", "rating": 4.6,
                                                         "userRatingCount": 212}]})
        return httpx.Response(200, json={"id": PLACE, "displayName": {"text": "Glow Salon"}, "rating": 4.6,
                                         "userRatingCount": 212, "googleMapsUri": "https://maps.google.com/?cid=1",
                                         "reviews": self.reviews})


@pytest.fixture
def google(services, monkeypatch):
    from kritvia_api.services.places import PlacesClient
    fake = FakeGoogle()
    monkeypatch.setattr(services, "places", PlacesClient("test-key", transport=httpx.MockTransport(fake)))
    return fake


async def test_listing_reviews_replies_and_asks(world, client, fake_llm, google):
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Glow Reviews", "slug": f"glowrv-{uuid.uuid4().hex[:6]}"})).json()["id"]
    await mayank.put(f"/ventures/{v}/settings", json={"kind": "general", "business_name": "Glow Salon", "city": "Pune"})
    operator = await make_actor(client, "rv-operator")
    await join(mayank, operator, world["org"], v, "operator")

    hits = (await mayank.get(f"/ventures/{v}/reviews/find-place", params={"q": "Glow Salon Pune"})).json()
    assert hits[0]["place_id"] == PLACE and hits[0]["count"] == 212
    assert (await operator.put(f"/ventures/{v}/review-settings", json={"place_id": PLACE})).status_code == 403
    assert (await mayank.put(f"/ventures/{v}/review-settings", json={"place_id": "bad id!"})).status_code == 422
    assert (await mayank.put(f"/ventures/{v}/review-settings", json={"place_id": PLACE})).status_code == 200

    fake_llm.on("draft Glow Salon's public reply to a Google review", lambda m: {
        "reply": "Thank you!" if "Rating: 5" in json.dumps(m) else "We're sorry about the wait; please call us so we can put it right."})
    assert (await mayank.put(f"/ventures/{v}/workflow-configs/reviews",
                             json={"enabled": True, "schedule": "19:00", "settings": {}, "instructions": ""})).status_code == 200
    r = await mayank.post(f"/ventures/{v}/runs", json={"workflow": "reviews", "input": {}})
    run = (await mayank.get(f"/ventures/{v}/runs/{r.json()['id']}")).json()
    assert run["summary"]["replies_drafted"] == 2, run

    page = (await operator.get(f"/ventures/{v}/reviews")).json()
    assert page["place"]["rating"] == 4.6 and page["place"]["write_review_url"].endswith(PLACE)
    by = {x["author"]: x for x in page["reviews"]}
    assert by["Meera Joshi"]["reply"]["draft"] == "Thank you!" and by["Rahul K"]["reply"]["draft"].startswith("We're sorry")
    # only a hash of each review is stored, never its words or author
    from conftest import ADMIN_DSN
    import asyncpg
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        rows = await conn.fetch("SELECT * FROM review_replies WHERE venture_id = $1", uuid.UUID(v))
    finally:
        await conn.close()
    stored = json.dumps([dict(x) for x in rows], default=str)
    assert "Rahul" not in stored and "Waited" not in stored and len(rows) == 2

    # the next day: nothing drafted twice
    r = await mayank.post(f"/ventures/{v}/runs", json={"workflow": "reviews", "input": {}})
    assert (await mayank.get(f"/ventures/{v}/runs/{r.json()['id']}")).json()["summary"]["replies_drafted"] == 0
    rid = by["Rahul K"]["reply"]["id"]
    ok = await operator.patch(f"/ventures/{v}/review-replies/{rid}", json={"status": "posted"})
    assert ok.json()["status"] == "posted"

    # a paid invoice and a finished booking: one review request each (by the customer's channel)
    ist = ZoneInfo("Asia/Kolkata")
    today = datetime.now(ist).date()
    inv = (await operator.post(f"/ventures/{v}/invoices", json={
        "customer_name": "Sana Shaikh", "customer_email": "sana@example.com", "amount_paise": 50000,
        "due_on": str(today)})).json()
    await operator.post(f"/ventures/{v}/invoices/{inv['id']}/payment", json={"amount_paise": 50000})
    await mayank.put(f"/ventures/{v}/booking-settings", json={"hours": {}, "notice_hours": 0})
    svc = (await mayank.post(f"/ventures/{v}/booking-services", json={"name": "Spa", "minutes": 60})).json()
    at = datetime(today.year, today.month, today.day, 9, 0, tzinfo=ist) - timedelta(days=1)
    b = (await operator.post(f"/ventures/{v}/bookings", json={"service_id": svc["id"], "starts_at": at.isoformat(),
                                                              "customer_name": "Tara Rao", "phone": "+91 99000 11223",
                                                              "outside_hours": True})).json()
    await operator.patch(f"/ventures/{v}/bookings/{b['id']}", json={"status": "done"})
    r = await mayank.post(f"/ventures/{v}/runs", json={"workflow": "reviews", "input": {}})
    assert (await mayank.get(f"/ventures/{v}/runs/{r.json()['id']}")).json()["summary"]["asks"] == 2
    asks = [a for a in (await mayank.get(f"/ventures/{v}/approvals")).json() if a["title"].startswith("Ask ")]
    by_to = {a["payload"]["to"]: a for a in asks}
    assert set(by_to) == {"sana@example.com", "919900011223"}
    assert f"writereview?placeid={PLACE}" in by_to["919900011223"]["payload"]["body"]
    assert by_to["sana@example.com"]["action"] == "gmail.send"
    # not asked twice
    r = await mayank.post(f"/ventures/{v}/runs", json={"workflow": "reviews", "input": {}})
    assert (await mayank.get(f"/ventures/{v}/runs/{r.json()['id']}")).json()["summary"]["asks"] == 0
