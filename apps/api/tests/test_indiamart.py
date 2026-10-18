"""IndiaMART: the Pull API key is checked and stored encrypted, the last day's enquiries go to Lead triage
at once, the worker fetches new ones window by window (each enquiry handled once), and a key IndiaMART
refuses is shown on the connector instead of being retried."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from sqlalchemy import text

from conftest import join, make_actor
from kritvia_api.db.session import tenant_tx
from kritvia_api.services import indiamart as im
from test_lead_triage import script_triage

KEY = "gIhfk7cDWoxdqBeFv+sb7kevHW7O1Axy"


def enquiry(qid: str, **kw) -> dict:
    return {"UNIQUE_QUERY_ID": qid, "QUERY_TYPE": "W", "QUERY_TIME": "2026-10-18 10:15:00",
            "SENDER_NAME": kw.get("name", "Priya Nair"), "SENDER_MOBILE": "+91-9876543210",
            "SENDER_EMAIL": kw.get("email", "priya@acmefoods.in"), "SENDER_COMPANY": kw.get("company", "Acme Foods"),
            "SENDER_CITY": "Pune", "QUERY_PRODUCT_NAME": "Website design",
            "QUERY_MESSAGE": kw.get("message", "Need a Next.js website with ordering, 5 pages.")}


class FakeIndiaMart:
    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.answer: dict = {"CODE": 204, "STATUS": "SUCCESS", "MESSAGE": "There are no leads", "RESPONSE": []}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        q = {k: v[0] for k, v in parse_qs(urlsplit(str(request.url)).query).items()}
        self.calls.append(q)
        if q.get("glusr_crm_key") != KEY:
            return httpx.Response(200, json={"CODE": 401, "STATUS": "FAILURE", "RESPONSE": [],
                                             "MESSAGE": "Pull API Key that you are using is incorrect. Kindly use the correct Pull API Key as provided in the email."})
        return httpx.Response(200, json=self.answer)

    def leads(self, *rows: dict) -> None:
        self.answer = {"CODE": 200, "STATUS": "SUCCESS", "MESSAGE": "", "TOTAL_RECORDS": len(rows), "RESPONSE": list(rows)}


@pytest.fixture
def imart(services):
    fake = FakeIndiaMart()
    old = services.indiamart
    services.indiamart = im.IndiaMartClient(transport=httpx.MockTransport(fake))
    yield fake
    services.indiamart = old


@pytest.fixture
async def shop(world, client):
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Acme Web", "slug": f"im-{uuid.uuid4().hex[:6]}"})).json()["id"]
    await mayank.put(f"/ventures/{v}/settings", json={"kind": "software", "business_name": "Acme Web", "city": "Delhi"})
    assert (await mayank.put(f"/ventures/{v}/workflow-configs/lead_triage",
                             json={"enabled": True, "settings": {}, "instructions": ""})).status_code == 200
    operator = await make_actor(client, "im-operator")
    await join(mayank, operator, world["org"], v, "operator")
    return {**world, "v": v, "operator": operator}


async def leads(actor, v) -> list[dict]:
    r = await actor.get(f"/ventures/{v}/leads")
    return [x for x in r.json() if x.get("source") == "indiamart"]


async def runs(actor, v) -> list[dict]:
    r = await actor.get(f"/ventures/{v}/runs", params={"workflow": "lead_triage"})
    return [x for x in r.json() if x["title"].startswith("IndiaMART")]


async def connector(actor, v) -> dict:
    return next(c for c in (await actor.get(f"/ventures/{v}/connectors")).json() if c["provider"] == "indiamart")


# ------------------------------------------------------------------- unit --
def test_parse_reads_enquiries_and_the_documented_failures():
    got = im.parse({"CODE": 200, "RESPONSE": [enquiry("101"), {"SENDER_NAME": "no id"}, enquiry("102", email="not-an-email")]})
    assert [e.id for e in got] == ["101", "102"] and got[1].email is None
    inp = got[0].lead_input()
    assert inp["source"] == "indiamart" and inp["company"] == "Acme Foods"
    assert "Phone: +91-9876543210" in inp["body"] and "Product: Website design" in inp["body"]
    assert "IndiaMART: Direct enquiry" in inp["body"] and inp["subject"] == "IndiaMART enquiry: Website design"
    assert im.parse({"CODE": 204, "RESPONSE": []}) == []
    with pytest.raises(im.IndiaMartError, match="expired"):
        im.parse({"CODE": 401, "MESSAGE": "Pull API Key that you are using has expired as it was no longer in use."})
    with pytest.raises(im.IndiaMartError, match="wrong"):
        im.parse({"CODE": 401, "MESSAGE": "incorrect"})
    with pytest.raises(im.TryLater):
        im.parse({"CODE": 429, "MESSAGE": "Too Many Requests"})
    with pytest.raises(im.TryLater):
        im.parse("not json")


def test_window_follows_indiamarts_rules():
    now = datetime(2026, 10, 18, 12, 0, tzinfo=im.IST)
    assert im.window(None, now) == (now - timedelta(hours=24), now)                     # first time: a day
    last = now - timedelta(minutes=10)
    assert im.window(last, now) == (last - timedelta(minutes=5), now)                   # 5 minutes overlap
    start, _ = im.window(now - timedelta(days=30), now)                                 # never more than 7 days
    assert now - start < timedelta(days=7)
    assert im.fmt(datetime(2026, 1, 5, 9, 3, 7, tzinfo=im.IST)) == "05-Jan-202609:03:07"


# ------------------------------------------------------------------ flows --
async def test_connect_checks_the_key_and_hands_the_last_day_to_lead_triage(shop, imart, fake_llm):
    mayank, v = shop["mayank"], shop["v"]
    script_triage(fake_llm)
    r = await mayank.post(f"/ventures/{v}/connectors/indiamart", json={"key": "wrong" + KEY})
    assert r.status_code == 422 and "key is wrong" in r.json()["detail"]
    assert not [c for c in (await mayank.get(f"/ventures/{v}/connectors")).json() if c["provider"] == "indiamart"]

    imart.leads(enquiry("5001"))
    r = await mayank.post(f"/ventures/{v}/connectors/indiamart", json={"key": KEY})
    assert r.status_code == 201, r.text
    assert r.json()["enquiries"] == 1
    call = imart.calls[-1]
    assert set(call) == {"glusr_crm_key", "start_time", "end_time"} and len(call["end_time"]) == 19
    got = await leads(mayank, v)
    assert len(got) == 1 and got[0]["company"].lower().startswith("acme")
    c = await connector(mayank, v)
    assert c["status"] == "active" and c["cursor"] and c["last_error"] is None
    # the key is stored encrypted, never in the clear
    async with tenant_tx(None, "system") as conn:
        run_as = (await conn.execute(text("SELECT run_as FROM private.active_connectors('indiamart') WHERE venture_id = :v"),
                                     {"v": uuid.UUID(v)})).scalar()
    async with tenant_tx(run_as, "agent", "indiamart") as conn:
        enc = (await conn.execute(text("SELECT secret_enc FROM connector_tokens WHERE connector_id = :c"),
                                  {"c": uuid.UUID(c["id"])})).scalar()
    assert enc and KEY.encode() not in bytes(enc)


async def test_polls_move_the_window_and_never_start_an_enquiry_twice(shop, imart, fake_llm, services):
    mayank, v = shop["mayank"], shop["v"]
    script_triage(fake_llm)
    assert (await mayank.post(f"/ventures/{v}/connectors/indiamart", json={"key": KEY})).status_code == 201
    first = await connector(mayank, v)

    imart.leads(enquiry("6001"), enquiry("6002", name="Rahul", email="rahul@bakes.in", company="Pune Bakes"))
    later = datetime.now(im.IST) + timedelta(minutes=10)
    async with tenant_tx(None, "system") as conn:
        row = (await conn.execute(text("SELECT * FROM private.active_connectors('indiamart') WHERE venture_id = :v"),
                                  {"v": uuid.UUID(v)})).first()
    assert await im.pull_venture(services, row.connector_id, row.venture_id, row.run_as, now=later) == 2
    q = imart.calls[-1]
    assert q["start_time"] == im.fmt(datetime.fromisoformat(first["cursor"]) - timedelta(minutes=5))
    assert q["end_time"] == im.fmt(later)
    assert len(await runs(mayank, v)) == 2
    # the same enquiries again (overlapping window): nothing new starts
    assert await im.pull_venture(services, row.connector_id, row.venture_id, row.run_as,
                                 now=later + timedelta(minutes=10)) == 0
    assert len(await runs(mayank, v)) == 2
    assert (await connector(mayank, v))["cursor"] == (later + timedelta(minutes=10)).isoformat()


async def test_a_refused_key_shows_on_the_connector_and_polling_stops(shop, imart, services):
    mayank, v = shop["mayank"], shop["v"]
    assert (await mayank.post(f"/ventures/{v}/connectors/indiamart", json={"key": KEY})).status_code == 201
    imart.answer = {"CODE": 401, "STATUS": "FAILURE", "RESPONSE": [],
                    "MESSAGE": "Pull API Key that you are using has expired as it was no longer in use."}
    async with tenant_tx(None, "system") as conn:
        row = (await conn.execute(text("SELECT * FROM private.active_connectors('indiamart') WHERE venture_id = :v"),
                                  {"v": uuid.UUID(v)})).first()
    assert await im.pull_venture(services, row.connector_id, row.venture_id, row.run_as) == 0
    c = await connector(mayank, v)
    assert c["status"] == "error" and "expired" in c["last_error"]
    async with tenant_tx(None, "system") as conn:
        assert not (await conn.execute(text("SELECT 1 FROM private.active_connectors('indiamart') WHERE venture_id = :v"),
                                       {"v": uuid.UUID(v)})).first()
    # pasting a working key again turns it back on
    imart.answer = {"CODE": 204, "RESPONSE": []}
    assert (await mayank.post(f"/ventures/{v}/connectors/indiamart", json={"key": KEY})).status_code == 201
    assert (await connector(mayank, v))["status"] == "active"


async def test_only_admins_connect_and_strangers_see_nothing(shop, imart, client):
    v, operator = shop["v"], shop["operator"]
    assert (await operator.post(f"/ventures/{v}/connectors/indiamart", json={"key": KEY})).status_code == 404
    stranger = await make_actor(client, "im-stranger")
    assert (await stranger.post(f"/ventures/{v}/connectors/indiamart", json={"key": KEY})).status_code in (403, 404)
    assert imart.calls == []
