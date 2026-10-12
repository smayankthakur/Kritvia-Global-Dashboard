"""Agents sending WhatsApp templates: the follow-up agent for enquiries that went quiet, and the assistant
sending a template on request. Always with a person's yes, and only to people who agreed to hear from
the business."""
from __future__ import annotations

import uuid

import asyncpg
import httpx
import pytest

from conftest import ADMIN_DSN, join, make_actor
from test_inbox_assistant import APP_SECRET, VERIFY
from test_whatsapp_front_door import approve_latest, hook, msg, script, wa_runs
from test_whatsapp_templates import FakeGraph, template_status

pytestmark = pytest.mark.asyncio

PNID = "5550003333"
WABA = "7770002222"
NEHA = "919811100011"
RAVI = "919811100022"
TEMPLATE = "Hi {{1}}, just checking in about {{2}}. Reply here and we will sort it out."


@pytest.fixture
def graph(services):
    from kritvia_api.services.whatsapp import WhatsAppClient
    fake = FakeGraph(PNID, WABA)
    wa = WhatsAppClient(APP_SECRET, VERIFY, transport=httpx.MockTransport(fake))
    old = services.whatsapp, services.messaging.whatsapp
    services.whatsapp = services.messaging.whatsapp = wa
    yield fake
    services.whatsapp, services.messaging.whatsapp = old


@pytest.fixture(scope="module")
async def salon(world, client):
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Glow Salon", "slug": f"glow-{uuid.uuid4().hex[:6]}"})).json()["id"]
    await mayank.put(f"/ventures/{v}/settings", json={"kind": "general", "business_name": "Glow Salon", "city": "Delhi"})
    assert (await mayank.put(f"/ventures/{v}/workflow-configs/inbox_assistant",
                             json={"enabled": True, "settings": {}, "instructions": ""})).status_code == 200
    approver = await make_actor(client, "fu-approver")
    await join(mayank, approver, world["org"], v, "approver")
    return {**world, "v": v, "approver": approver}


def to_us(payload: dict) -> dict:
    payload["entry"][0]["changes"][0]["value"]["metadata"]["phone_number_id"] = PNID
    return payload


async def admin(sql: str, *args) -> list:
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        return await conn.fetch(sql, *args)
    finally:
        await conn.close()


async def age_chat(phone: str, days: int) -> None:
    """Moves a chat's messages back in time, as if it went quiet `days` ago."""
    await admin("UPDATE wa_messages m SET created_at = m.created_at - make_interval(days => $2)"
                " FROM wa_contacts c WHERE c.id = m.contact_id AND c.phone = $1", phone, days)


async def followup_runs(actor, v) -> list[dict]:
    return (await actor.get(f"/ventures/{v}/runs", params={"workflow": "whatsapp_followup"})).json()


async def test_a_quiet_enquiry_gets_one_approved_follow_up(salon, client, fake_llm, graph):
    mayank, approver, v = salon["mayank"], salon["approver"], salon["v"]
    r = await mayank.post(f"/ventures/{v}/connectors/whatsapp",
                          json={"phone_number_id": PNID, "access_token": "EAAB" + "f" * 40, "waba_id": WABA})
    assert r.status_code == 201, r.text
    r = await mayank.post(f"/ventures/{v}/whatsapp/templates", json={
        "label": "Follow up", "category": "UTILITY", "body": TEMPLATE, "examples": ["Neha", "the bridal package"]})
    assert r.status_code == 201, r.text
    await hook(client, template_status("APPROVED", graph.templates["follow_up"]["id"], "follow_up", waba=WABA))

    # Neha asks, Kritvia's reply is approved and sent; Ravi asks but nobody has answered yet
    script(fake_llm, reply="Ji, bridal package ₹15,000 se shuru hota hai.")
    await hook(client, to_us(msg("wamid.f1", "Bridal package kitne ka hai?", sender=NEHA, name="Neha")))
    run = next(x for x in await wa_runs(mayank, v) if "Neha" in x["title"])
    await approve_latest(approver, v, run["id"])
    await hook(client, to_us(msg("wamid.f2", "Hair spa ka rate?", sender=RAVI, name="Ravi")))

    # without a template chosen the agent does nothing
    assert (await mayank.put(f"/ventures/{v}/workflow-configs/whatsapp_followup", json={
        "enabled": True, "schedule": "11:00", "settings": {}, "instructions": ""})).status_code == 200
    r = await mayank.post(f"/ventures/{v}/runs", json={"workflow": "whatsapp_followup", "input": {}})
    assert r.status_code == 201, r.text
    first = (await mayank.get(f"/ventures/{v}/runs/{r.json()['id']}")).json()
    assert first["outcome"] == "no_template"

    cfg = {"template": "Follow up", "after_days": 2, "max_followups": 1, "only_leads": True}
    assert (await mayank.put(f"/ventures/{v}/workflow-configs/whatsapp_followup", json={
        "enabled": True, "schedule": "11:00", "settings": cfg, "instructions": ""})).status_code == 200
    # not quiet long enough yet
    r = await mayank.post(f"/ventures/{v}/runs", json={"workflow": "whatsapp_followup", "input": {}})
    assert (await mayank.get(f"/ventures/{v}/runs/{r.json()['id']}")).json()["summary"]["touches"] == 0

    await age_chat(NEHA, 3)
    await age_chat(RAVI, 3)                    # quiet too, but the customer wrote last: not a follow-up
    fake_llm.on("You fill in the blanks", {"params": ["Neha", "the bridal package"], "skip": False, "reason": ""})
    r = await mayank.post(f"/ventures/{v}/runs", json={"workflow": "whatsapp_followup", "input": {}})
    assert (await mayank.get(f"/ventures/{v}/runs/{r.json()['id']}")).json()["summary"]["touches"] == 1
    touch = next(x for x in await followup_runs(mayank, v) if x["status"] == "waiting")
    fills = fake_llm.chat_calls("You fill in the blanks")
    assert "Bridal package kitne ka hai?" in fills[-1]["prompt"] and TEMPLATE in fills[-1]["prompt"]

    a = next(x for x in (await approver.get("/approvals/inbox")).json() if x["run_id"] == touch["id"])
    assert a["action"] == "whatsapp.template"
    assert a["payload"]["to"] == NEHA and a["payload"]["template"] == "Follow up"
    assert a["payload"]["body"] == "Hi Neha, just checking in about the bridal package. Reply here and we will sort it out."
    # the wording is WhatsApp's: no edits, only yes or no
    e = await approver.post(f"/ventures/{v}/approvals/{a['id']}/decision",
                            json={"decision": "approve", "edited_payload": {"body": "Hi!"}})
    assert e.status_code == 422
    sent_before = len(graph.sent)
    assert (await approver.post(f"/ventures/{v}/approvals/{a['id']}/decision",
                                json={"decision": "approve"})).status_code == 200
    assert len(graph.sent) == sent_before + 1
    assert graph.sent[-1]["type"] == "template" and graph.sent[-1]["to"] == NEHA
    assert graph.sent[-1]["template"]["components"][0]["parameters"] == [
        {"type": "text", "text": "Neha"}, {"type": "text", "text": "the bridal package"}]
    assert (await mayank.get(f"/ventures/{v}/runs/{touch['id']}")).json()["outcome"] == "followed_up"
    chat = next(c for c in (await mayank.get(f"/ventures/{v}/whatsapp/chats")).json()["chats"] if c["phone"] == NEHA)
    detail = (await mayank.get(f"/ventures/{v}/whatsapp/chats/{chat['id']}")).json()
    last = detail["messages"][-1]
    assert (last["sent_by"], last["kind"], last["status"]) == ("kritvia", "template", "sent")

    # one follow-up per quiet spell: even after more quiet days, nothing more until she writes
    await age_chat(NEHA, 3)
    r = await mayank.post(f"/ventures/{v}/runs", json={"workflow": "whatsapp_followup", "input": {}})
    assert (await mayank.get(f"/ventures/{v}/runs/{r.json()['id']}")).json()["summary"]["touches"] == 0
    # her reply restarts the count
    script(fake_llm, reply="Ji, Saturday 11 baje ka slot hai.")
    await hook(client, to_us(msg("wamid.f3", "Haan, Saturday ko aa sakti hoon?", sender=NEHA, name="Neha")))
    rows = await admin("SELECT followups_sent, opt_in_source FROM wa_contacts WHERE phone = $1", NEHA)
    assert rows[0]["followups_sent"] == 0 and rows[0]["opt_in_source"] == "wrote_first"


async def test_the_agent_skips_chats_it_should_leave_alone(salon, client, fake_llm, graph):
    mayank, approver, v = salon["mayank"], salon["approver"], salon["v"]
    sender = "919811100033"
    script(fake_llm, reply="Ji, facial ₹1,200 ka hai.")
    await hook(client, to_us(msg("wamid.g1", "Facial ka rate?", sender=sender, name="Isha")))
    run = next(x for x in await wa_runs(mayank, v) if "Isha" in x["title"])
    await approve_latest(approver, v, run["id"])
    await age_chat(sender, 3)
    # the model sees she already said no: no follow-up, and the chat isn't asked about again
    fake_llm.on("You fill in the blanks", {"params": [], "skip": True, "reason": "she said she booked elsewhere"})
    r = await mayank.post(f"/ventures/{v}/runs", json={"workflow": "whatsapp_followup", "input": {}})
    assert (await mayank.get(f"/ventures/{v}/runs/{r.json()['id']}")).json()["summary"]["touches"] == 1
    touch = next(x for x in await followup_runs(mayank, v) if x["outcome"] == "not_suitable")
    assert "booked elsewhere" in str((await mayank.get(f"/ventures/{v}/runs/{touch['id']}")).json())
    r = await mayank.post(f"/ventures/{v}/runs", json={"workflow": "whatsapp_followup", "input": {}})
    assert (await mayank.get(f"/ventures/{v}/runs/{r.json()['id']}")).json()["summary"]["touches"] == 0


async def test_the_assistant_sends_a_template_on_request(salon, fake_llm, graph):
    mayank, approver, v = salon["mayank"], salon["approver"], salon["v"]

    def step(messages):
        p = messages[-1]["content"]
        if "Nothing yet." in p and "stranger" in p:
            return {"thought": "send it", "tool": "whatsapp.template", "title": "Template to a new number",
                    "args": {"to": "+91 90000 11111", "template": "Follow up", "params": ["Amit", "the offer"]}}
        if "Nothing yet." in p:
            return {"thought": "send Neha the follow-up", "tool": "whatsapp.template", "title": "Follow-up to Neha",
                    "args": {"to": "+91 98111 00011", "template": "follow up", "params": ["Neha", "your Saturday slot"]}}
        return {"thought": "done", "answer": "Done." if "approved by the person" in p else "I can't message them."}
    fake_llm.on("You are the business's assistant", step)

    # someone who never wrote to the business can't be messaged, even on request
    r = await mayank.post(f"/ventures/{v}/runs", json={"workflow": "assistant", "input": {"request": "Message this stranger"}})
    run = (await mayank.get(f"/ventures/{v}/runs/{r.json()['id']}")).json()
    assert run["status"] == "completed"
    assert not [a for a in (await approver.get("/approvals/inbox")).json() if a["run_id"] == run["id"]]

    r = await mayank.post(f"/ventures/{v}/runs", json={"workflow": "assistant",
                                                       "input": {"request": "Neha ko follow up template bhejo"}})
    run_id = r.json()["id"]
    a = next(x for x in (await approver.get("/approvals/inbox")).json() if x["run_id"] == run_id)
    assert a["action"] == "whatsapp.template" and a["payload"]["to"] == NEHA
    assert a["payload"]["body"] == "Hi Neha, just checking in about your Saturday slot. Reply here and we will sort it out."
    assert (await approver.post(f"/ventures/{v}/approvals/{a['id']}/decision",
                                json={"decision": "approve"})).status_code == 200
    assert graph.sent[-1]["template"]["name"] == "follow_up"
    assert (await mayank.get(f"/ventures/{v}/runs/{run_id}")).json()["status"] == "completed"


async def test_whatsapp_approvals_keep_their_recipient():
    from fastapi import HTTPException

    from kritvia_api.routers.approvals import validate_edit
    original = {"to": "919811100011", "body": "Hi"}
    assert validate_edit(original, {"body": "Hello"}, "whatsapp.send") == {"to": "919811100011", "body": "Hello"}
    with pytest.raises(HTTPException):
        validate_edit(original, {"to": "919999999999"}, "whatsapp.send")
    with pytest.raises(HTTPException):
        validate_edit({"to": "9198", "params": ["a"], "body": "x"}, {"params": ["b"]}, "whatsapp.template")
    with pytest.raises(HTTPException):
        validate_edit({"to": "a@b.in", "subject": "s", "body": "b"}, {"to": "nope"}, "gmail.send")
