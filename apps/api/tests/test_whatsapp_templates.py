"""WhatsApp templates (written in Kritvia, reviewed by Meta, sent to write first or after 24 hours) and
messages the owner sends from the WhatsApp Business app on the phone."""
from __future__ import annotations

import json
import uuid

import httpx
import pytest

from conftest import join, make_actor
from test_inbox_assistant import APP_SECRET, VERIFY
from test_whatsapp_front_door import hook, msg, script, wa_runs

pytestmark = pytest.mark.asyncio

PNID = "5550002222"
WABA = "7770001111"
CUSTOMER = "919811155566"


class FakeGraph:
    """Graph API stand-in for one WhatsApp account: number, templates and sends."""
    def __init__(self, pnid: str | None = None, waba: str | None = None) -> None:
        self.pnid, self.waba = pnid or PNID, waba or WABA
        self.sent: list[dict] = []
        self.templates: dict[str, dict] = {}
        self.created: list[dict] = []
        self.deleted: list[dict] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.method == "GET" and path.endswith(f"/{self.waba}/phone_numbers"):
            return httpx.Response(200, json={"data": [{"id": self.pnid}]})
        if request.method == "GET" and path.endswith("/phone_numbers"):
            return httpx.Response(200, json={"data": []})
        if path.endswith(f"/{self.waba}/message_templates"):
            if request.method == "GET":
                return httpx.Response(200, json={"data": list(self.templates.values())})
            if request.method == "DELETE":
                self.deleted.append(dict(request.url.params))
                self.templates.pop(request.url.params.get("name", ""), None)
                return httpx.Response(200, json={"success": True})
            body = json.loads(request.content)
            self.created.append(body)
            tid = str(len(self.created) + 9000)
            self.templates[body["name"]] = {"id": tid, "status": "PENDING", **body}
            return httpx.Response(200, json={"id": tid, "status": "PENDING", "category": body["category"]})
        if request.method == "GET":
            return httpx.Response(200, json={"display_phone_number": "+91 98765 22222", "verified_name": "Fresh Bakes"})
        body = json.loads(request.content)
        if body.get("status") == "read":
            return httpx.Response(200, json={"success": True})
        self.sent.append(body)
        return httpx.Response(200, json={"messages": [{"id": f"wamid.{uuid.uuid4().hex}"}]})


@pytest.fixture
def graph(services):
    from kritvia_api.services.whatsapp import WhatsAppClient
    fake = FakeGraph()
    wa = WhatsAppClient(APP_SECRET, VERIFY, transport=httpx.MockTransport(fake))
    old = services.whatsapp, services.messaging.whatsapp
    services.whatsapp = services.messaging.whatsapp = wa
    yield fake
    services.whatsapp, services.messaging.whatsapp = old


@pytest.fixture(scope="module")
async def bakery(world, client):
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Fresh Bakes", "slug": f"bakes-{uuid.uuid4().hex[:6]}"})).json()["id"]
    await mayank.put(f"/ventures/{v}/settings", json={"kind": "general", "business_name": "Fresh Bakes", "city": "Delhi"})
    assert (await mayank.put(f"/ventures/{v}/workflow-configs/inbox_assistant",
                             json={"enabled": True, "settings": {}, "instructions": ""})).status_code == 200
    approver = await make_actor(client, "tpl-approver")
    await join(mayank, approver, world["org"], v, "approver")
    operator = await make_actor(client, "tpl-operator")
    await join(mayank, operator, world["org"], v, "operator")
    return {**world, "v": v, "approver": approver, "operator": operator}


def template_status(event: str, tid: str, name: str, *, waba: str = WABA, reason: str = "NONE") -> dict:
    return {"object": "whatsapp_business_account", "entry": [{"id": waba, "time": 1700000000, "changes": [{
        "field": "message_template_status_update",
        "value": {"event": event, "message_template_id": int(tid), "message_template_name": name,
                  "message_template_language": "en", "reason": reason}}]}]}


def echo(mid: str, body: str, *, to: str = CUSTOMER) -> dict:
    return {"object": "whatsapp_business_account", "entry": [{"id": WABA, "changes": [{
        "field": "smb_message_echoes",
        "value": {"messaging_product": "whatsapp",
                  "metadata": {"display_phone_number": "919876522222", "phone_number_id": PNID},
                  "message_echoes": [{"from": "919876522222", "to": to, "id": mid, "timestamp": "1700000000",
                                      "type": "text", "text": {"body": body}}]}}]}]}


async def test_templates_are_written_reviewed_and_sent(bakery, client, graph):
    mayank, operator, approver, v = bakery["mayank"], bakery["operator"], bakery["approver"], bakery["v"]
    # connecting with a token: the account id is only kept when the number belongs to it
    bad = await mayank.post(f"/ventures/{v}/connectors/whatsapp",
                            json={"phone_number_id": PNID, "access_token": "EAAB" + "t" * 40, "waba_id": "1234567"})
    assert bad.status_code == 422
    r = await mayank.post(f"/ventures/{v}/connectors/whatsapp",
                          json={"phone_number_id": PNID, "access_token": "EAAB" + "t" * 40, "waba_id": WABA})
    assert r.status_code == 201, r.text
    t = (await mayank.get(f"/ventures/{v}/whatsapp/templates")).json()
    assert t == {"connected": True, "manageable": True, "templates": []}

    base = {"label": "Order ready!", "category": "UTILITY", "language": "en"}
    for body, examples, why in (("{{1}}, your order is ready", ["Neha"], "start or end"),
                                ("Hi {{2}}, your order is ready today", ["Neha"], "in order"),
                                ("Hi {{1}}, your order {{2}} is ready for pickup today.", ["Neha"], "sample")):
        r = await operator.post(f"/ventures/{v}/whatsapp/templates", json={**base, "body": body, "examples": examples})
        assert r.status_code == 422 and why in r.json()["detail"], r.text
    assert graph.created == []                      # nothing reached Meta
    good = {**base, "body": "Hi {{1}}, your order {{2}} is ready for pickup today.", "examples": ["Neha", "#1042"]}
    assert (await approver.post(f"/ventures/{v}/whatsapp/templates", json=good)).status_code == 403
    r = await operator.post(f"/ventures/{v}/whatsapp/templates", json=good)
    assert r.status_code == 201, r.text
    tpl = r.json()
    assert tpl["name"] == "order_ready" and tpl["status"] == "PENDING" and tpl["params"] == 2
    assert graph.created[-1]["components"] == [{"type": "BODY", "text": good["body"],
                                                "example": {"body_text": [["Neha", "#1042"]]}}]
    assert (await operator.post(f"/ventures/{v}/whatsapp/templates", json=good)).status_code == 409

    # not sendable until Meta approves it
    new = {"phone": "+91 98111 55566", "name": "Neha", "template_id": tpl["id"], "params": ["Neha", "#1042"],
           "consent": True}
    r = await operator.post(f"/ventures/{v}/whatsapp/chats", json=new)
    assert r.status_code == 409 and "approved" in r.json()["detail"]
    # Meta's review arrives at the webhook (per WhatsApp account); unknown accounts are ignored
    assert (await hook(client, template_status("APPROVED", graph.templates["order_ready"]["id"],
                                               "order_ready")))["accepted"] == 1
    assert (await hook(client, template_status("APPROVED", "1", "x", waba="999")))["ignored"] == 1
    t = (await approver.get(f"/ventures/{v}/whatsapp/templates")).json()["templates"]
    assert t[0]["status"] == "APPROVED"

    # writing first: consent is required, the number needs its country code, every blank is filled
    assert (await operator.post(f"/ventures/{v}/whatsapp/chats", json={**new, "consent": False})).status_code == 422
    assert (await operator.post(f"/ventures/{v}/whatsapp/chats", json={**new, "phone": "0981115556"})).status_code == 422
    r = await operator.post(f"/ventures/{v}/whatsapp/chats", json={**new, "params": ["Neha"]})
    assert r.status_code == 422 and "blank" in r.json()["detail"]
    r = await operator.post(f"/ventures/{v}/whatsapp/chats", json={**new, "params": ["Neha", "#10\n42"]})
    assert r.status_code == 422
    assert (await approver.post(f"/ventures/{v}/whatsapp/chats", json=new)).status_code == 403
    r = await operator.post(f"/ventures/{v}/whatsapp/chats", json=new)
    assert r.status_code == 201, r.text
    chat = r.json()
    assert chat["phone"] == CUSTOMER and chat["name"] == "Neha" and chat["window_open"] is False
    assert chat["handled_by"] == "kritvia"          # her answer is drafted like any other chat
    assert chat["last_message"] == "Hi Neha, your order #1042 is ready for pickup today."
    assert graph.sent[-1] == {"messaging_product": "whatsapp", "recipient_type": "individual", "to": CUSTOMER,
                              "type": "template", "template": {
                                  "name": "order_ready", "language": {"code": "en"},
                                  "components": [{"type": "body", "parameters": [
                                      {"type": "text", "text": "Neha"}, {"type": "text", "text": "#1042"}]}]}}
    detail = (await mayank.get(f"/ventures/{v}/whatsapp/chats/{chat['id']}")).json()
    assert [(m["kind"], m["sent_by"]) for m in detail["messages"]] == [("template", "person")]

    # in an existing chat, after the 24 hours
    r = await operator.post(f"/ventures/{v}/whatsapp/chats/{chat['id']}/template",
                            json={"template_id": tpl["id"], "params": ["Neha", "#1043"]})
    assert r.status_code == 201 and r.json()["body"].endswith("#1043 is ready for pickup today.")

    # refreshing picks up templates written in WhatsApp Manager; ones needing a photo can't be sent here
    graph.templates["diwali_offer"] = {
        "id": "8001", "name": "diwali_offer", "language": "hi", "status": "APPROVED", "category": "MARKETING",
        "components": [{"type": "HEADER", "format": "IMAGE"}, {"type": "BODY", "text": "Diwali par 20% off!"}]}
    assert (await approver.get(f"/ventures/{v}/whatsapp/templates", params={"refresh": True})).status_code == 403
    t = (await operator.get(f"/ventures/{v}/whatsapp/templates", params={"refresh": True})).json()["templates"]
    offer = next(x for x in t if x["name"] == "diwali_offer")
    assert offer["sendable"] is False and offer["category"] == "MARKETING"
    r = await operator.post(f"/ventures/{v}/whatsapp/chats/{chat['id']}/template", json={"template_id": offer["id"]})
    assert r.status_code == 409 and "WhatsApp Manager" in r.json()["detail"]
    # …and drops ones deleted there
    graph.templates.pop("diwali_offer")
    t = (await operator.get(f"/ventures/{v}/whatsapp/templates", params={"refresh": True})).json()["templates"]
    assert [x["name"] for x in t] == ["order_ready"]

    # a rejection is shown with Meta's reason
    await hook(client, template_status("REJECTED", graph.templates["order_ready"]["id"], "order_ready",
                                       reason="INVALID_FORMAT"))
    t = (await mayank.get(f"/ventures/{v}/whatsapp/templates")).json()["templates"][0]
    assert t["status"] == "REJECTED" and t["reason"] == "INVALID_FORMAT"

    # only admins delete, and it goes from the WhatsApp account too
    assert (await operator.delete(f"/ventures/{v}/whatsapp/templates/{tpl['id']}")).status_code == 403
    assert (await mayank.delete(f"/ventures/{v}/whatsapp/templates/{tpl['id']}")).status_code == 204
    assert graph.deleted[-1]["name"] == "order_ready"
    assert (await mayank.get(f"/ventures/{v}/whatsapp/templates")).json()["templates"] == []


async def test_templates_are_private(bakery):
    mallory, v = bakery["mallory"], bakery["v"]
    assert (await mallory.get(f"/ventures/{v}/whatsapp/templates")).status_code == 404
    r = await mallory.post(f"/ventures/{v}/whatsapp/templates",
                           json={"label": "x", "category": "UTILITY", "body": "Hello there, thanks for writing."})
    assert r.status_code == 404


async def test_answering_from_the_phone_takes_the_chat_over(bakery, client, fake_llm, graph):
    mayank, v = bakery["mayank"], bakery["v"]
    sender = "919811177788"
    script(fake_llm, category="support", reply="Ji, cake 4 baje tak ready ho jayega.")
    payload = msg("wamid.e2", "Cake kab tak ready hoga?", sender=sender, name="Isha")
    payload["entry"][0]["changes"][0]["value"]["metadata"]["phone_number_id"] = PNID
    await hook(client, payload)
    run = next(x for x in await wa_runs(mayank, v) if "Isha" in x["title"])
    assert run["status"] == "waiting"

    # the owner answers from the WhatsApp Business app on the phone
    assert (await hook(client, echo("wamid.e3", "4 baje aa jaiye", to=sender))) == {"accepted": 1, "ignored": 0}
    chat = next(c for c in (await mayank.get(f"/ventures/{v}/whatsapp/chats")).json()["chats"] if c["phone"] == sender)
    assert chat["handled_by"] == "person" and chat["handoff_reason"] == "Answered from the WhatsApp Business app"
    assert chat["pending_approval_id"] is None       # Kritvia's draft is withdrawn: no second answer
    assert (await mayank.get(f"/ventures/{v}/runs/{run['id']}")).json()["status"] == "cancelled"
    detail = (await mayank.get(f"/ventures/{v}/whatsapp/chats/{chat['id']}")).json()
    assert [(m["direction"], m["sent_by"], m["body"]) for m in detail["messages"]][-1] == \
        ("out", "phone", "4 baje aa jaiye")
    # redelivered echoes are ignored
    assert (await hook(client, echo("wamid.e3", "4 baje aa jaiye", to=sender))) == {"accepted": 0, "ignored": 1}


async def test_a_reply_from_the_page_withdraws_kritvias_draft(bakery, client, fake_llm, graph):
    mayank, operator, v = bakery["mayank"], bakery["operator"], bakery["v"]
    sender = "919811199900"
    script(fake_llm, category="support")
    payload = msg("wamid.r1", "Eggless hai?", sender=sender, name="Om")
    payload["entry"][0]["changes"][0]["value"]["metadata"]["phone_number_id"] = PNID
    await hook(client, payload)
    run = next(x for x in await wa_runs(mayank, v) if "Om" in x["title"])
    assert run["status"] == "waiting"
    chat = next(c for c in (await mayank.get(f"/ventures/{v}/whatsapp/chats")).json()["chats"] if c["phone"] == sender)
    r = await operator.post(f"/ventures/{v}/whatsapp/chats/{chat['id']}/reply", json={"body": "Haan, eggless hai"})
    assert r.status_code == 201, r.text
    assert (await mayank.get(f"/ventures/{v}/runs/{run['id']}")).json()["status"] == "cancelled"


async def test_template_rules_and_parsing():
    from kritvia_api.routers.whatsapp_chats import slug
    from kritvia_api.services.whatsapp import (_from_meta, check_param, check_template_body, parse_echoes,
                                               parse_template_statuses, render_template)
    assert check_template_body("Hi {{1}}, thanks for your order. See you soon!") is None
    assert "blank" in check_template_body("Hi {{1}} {{2}} {{3}} ok")
    assert "numbers only" in check_template_body("Hi {{name}}, thanks for your order today")
    assert check_param("Neha") is None and check_param(" ") and check_param("a\nb") and check_param("a     b")
    assert render_template("Hi {{1}}, order {{2}}", ["Neha", "#7"]) == "Hi Neha, order #7"
    assert slug("Order ready! (v2)") == "order_ready_v2" and slug("!!!") == "message"
    st = parse_template_statuses(template_status("PAUSED", "42", "promo", reason="NONE"))
    assert st[0].status == "PAUSED" and st[0].reason is None and st[0].waba_id == WABA
    e = parse_echoes(echo("wamid.x", "Hello"))
    assert e[0].to == CUSTOMER and e[0].text == "Hello" and e[0].phone_number_id == PNID
    ok = _from_meta({"id": "1", "name": "a", "language": "en", "status": "APPROVED", "category": "UTILITY",
                     "components": [{"type": "HEADER", "format": "TEXT", "text": "Order"},
                                    {"type": "BODY", "text": "Hi {{1}}, done", "example": {"body_text": [["Neha"]]}},
                                    {"type": "BUTTONS", "buttons": [{"type": "QUICK_REPLY", "text": "OK"}]}]})
    assert ok and ok.sendable and ok.params == 1 and ok.examples == ["Neha"]
    link = _from_meta({"id": "2", "name": "b", "language": "en", "category": "MARKETING", "components": [
        {"type": "BODY", "text": "See our menu"},
        {"type": "BUTTONS", "buttons": [{"type": "URL", "url": "https://x.in/{{1}}"}]}]})
    assert link and not link.sendable and link.status == "PENDING"
    assert _from_meta({"name": "c", "language": "en", "components": []}) is None
