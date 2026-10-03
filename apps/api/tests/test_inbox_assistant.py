"""Inbox assistant for any business: classify, hand off, draft a reply for approval,
follow the owner's instructions; WhatsApp in and out; agent options; sample run."""
from __future__ import annotations

import hashlib
import hmac
import json
import uuid

import httpx
import pytest

from conftest import join, make_actor

pytestmark = pytest.mark.asyncio

SUPPORT_MAIL = {"channel": "email", "from_name": "Rahul", "from_email": "rahul@example.com",
                "subject": "Delivery time?", "body": "Hi, how long does delivery to Pune take? Rahul",
                "message_id": None, "thread_id": None}


def script_inbox(fake, *, category="support", needs_reply=True):
    fake.on("You sort the business's incoming messages", {
        "category": category, "summary": "Rahul asks how long delivery to Pune takes.",
        "needs_reply": needs_reply, "language": "en", "urgency": "medium"})
    fake.on("You answer the business's", lambda msgs: {
        "subject": "Re: Delivery time?",
        "body": "Hi Rahul, delivery to Pune takes 3-5 working days. — " +
                ("Hinglish-bhi" if "Hinglish" in msgs[0]["content"] else "Team"),
        "used_sources": [1], "unsure": False})


@pytest.fixture(scope="module")
async def shop(world, client):
    """A 'general' business (a shop) with the inbox assistant on and an approver."""
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures", json={"name": "Shop", "slug": f"shop-{uuid.uuid4().hex[:6]}"})).json()["id"]
    await mayank.put(f"/ventures/{v}/settings", json={"kind": "general", "business_name": "Mehta Stores", "city": "Pune"})
    r = await mayank.put(f"/ventures/{v}/workflow-configs/inbox_assistant",
                         json={"enabled": True, "settings": {}, "instructions": "Always reply in Hinglish."})
    assert r.status_code == 200, r.text
    assert r.json()["instructions"] == "Always reply in Hinglish."
    approver = await make_actor(client, "shop-approver")
    await join(mayank, approver, world["org"], v, "approver")
    return {**world, "shop": v, "approver": approver}


async def test_catalogue_lists_options_and_trigger(world):
    cat = (await world["mayank"].get("/workflows")).json()
    inbox = next(w for w in cat if w["name"] == "inbox_assistant")
    assert inbox["venture_kinds"] == ["general", "software", "finance", "kitchen"]
    assert {o["key"] for o in inbox["options"]} >= {"draft_replies", "reply_language", "hand_off_leads"}
    lead = next(w for w in cat if w["name"] == "lead_triage")
    assert any(o["key"] == "draft_proposal" and o["type"] == "boolean" for o in lead["options"])
    assert lead["trigger"]


async def test_reply_drafted_for_approval_following_instructions(shop, fake_llm):
    mayank, approver, v = shop["mayank"], shop["approver"], shop["shop"]
    script_inbox(fake_llm)
    r = await mayank.post(f"/ventures/{v}/runs", json={"workflow": "inbox_assistant", "input": SUPPORT_MAIL})
    assert r.status_code == 201, r.text
    run = (await mayank.get(f"/ventures/{v}/runs/{r.json()['id']}")).json()
    assert run["status"] == "waiting" and run["current_step"] == "send", run
    assert [s["step"] for s in run["steps"]] == ["classify", "retrieve", "draft"]
    # the owner's instructions reached the drafting prompt
    assert any("Always reply in Hinglish" in c["prompt"] for c in fake_llm.chat_calls("You answer the business's"))
    inbox = [a for a in (await approver.get("/approvals/inbox")).json() if a["run_id"] == run["id"]]
    assert len(inbox) == 1 and inbox[0]["action"] == "gmail.send"
    assert inbox[0]["payload"]["to"] == "rahul@example.com" and "Hinglish-bhi" in inbox[0]["payload"]["body"]
    d = await approver.post(f"/ventures/{v}/approvals/{inbox[0]['id']}/decision", json={"decision": "approve"})
    assert d.status_code == 200, d.text
    run = (await mayank.get(f"/ventures/{v}/runs/{run['id']}")).json()
    assert run["status"] == "completed" and run["outcome"] == "replied"
    # the message was filed in Knowledge
    docs = (await mayank.get(f"/ventures/{v}/documents")).json()
    assert any(d["kind"] == "email" and d["title"] == "Delivery time?" for d in docs)


async def test_no_reply_needed_is_filed_and_replies_can_be_switched_off(shop, fake_llm):
    mayank, v = shop["mayank"], shop["shop"]
    script_inbox(fake_llm, category="update", needs_reply=False)
    r = await mayank.post(f"/ventures/{v}/runs", json={"workflow": "inbox_assistant", "input": SUPPORT_MAIL})
    run = (await mayank.get(f"/ventures/{v}/runs/{r.json()['id']}")).json()
    assert run["status"] == "completed" and run["outcome"] == "filed"

    await mayank.put(f"/ventures/{v}/workflow-configs/inbox_assistant",
                     json={"enabled": True, "settings": {"draft_replies": False}})
    script_inbox(fake_llm)
    r = await mayank.post(f"/ventures/{v}/runs", json={"workflow": "inbox_assistant", "input": SUPPORT_MAIL})
    run = (await mayank.get(f"/ventures/{v}/runs/{r.json()['id']}")).json()
    assert run["outcome"] == "filed" and len(run["steps"]) == 1
    await mayank.put(f"/ventures/{v}/workflow-configs/inbox_assistant",
                     json={"enabled": True, "settings": {}, "instructions": "Always reply in Hinglish."})


async def test_enquiry_handed_to_lead_triage_when_on(shop, fake_llm):
    mayank, v = shop["mayank"], shop["shop"]
    await mayank.put(f"/ventures/{v}/workflow-configs/lead_triage",
                     json={"enabled": True, "settings": {"draft_proposal": False}})
    script_inbox(fake_llm, category="enquiry")
    fake_llm.on("You triage inbound inquiries", {"contact_name": "Rahul", "summary": "wants delivery",
                                                "requirements": ["delivery"], "scope": [], "urgency": "low"})
    fake_llm.on("Assess how well this inquiry fits", {"fit": "partial", "reason": "ok"})
    r = await mayank.post(f"/ventures/{v}/runs", json={"workflow": "inbox_assistant",
                                                       "input": {**SUPPORT_MAIL, "message_id": "m-1"}})
    run = (await mayank.get(f"/ventures/{v}/runs/{r.json()['id']}")).json()
    assert run["outcome"] == "handed_to_lead_triage"
    lead_run = (await mayank.get(f"/ventures/{v}/runs/{run['summary']['lead_run_id']}")).json()
    # draft_proposal is off: lead triage scores and stops without pricing or drafting
    assert lead_run["status"] == "completed" and lead_run["outcome"] == "scored"
    assert [s["step"] for s in lead_run["steps"]] == ["extract", "upsert_lead", "retrieve", "score"]
    await mayank.put(f"/ventures/{v}/workflow-configs/lead_triage", json={"enabled": False, "settings": {}})


async def test_sample_run_gives_a_first_result(shop, fake_llm):
    mayank, v = shop["mayank"], shop["shop"]
    script_inbox(fake_llm)
    r = await mayank.post(f"/ventures/{v}/sample-run")
    assert r.status_code == 201, r.text
    run = (await mayank.get(f"/ventures/{v}/runs/{r.json()['run_id']}")).json()
    assert run["status"] == "waiting" and run["title"] == "Sample enquiry (try it)"


# ----------------------------------------------------------------- WhatsApp --
APP_SECRET, VERIFY = "app-secret-123", "verify-me"


class FakeMeta:
    """Graph API stand-in: number lookup and message send."""
    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.fail = False

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            if "bad" in request.url.path:
                return httpx.Response(400, json={"error": {"message": "nope"}})
            return httpx.Response(200, json={"display_phone_number": "+91 98765 00000", "verified_name": "Mehta Stores"})
        body = json.loads(request.content)
        if body.get("status") == "read":
            return httpx.Response(200, json={"success": True})
        if self.fail:
            return httpx.Response(400, json={"error": {"code": 131047, "message": "Re-engagement message"}})
        self.sent.append({"path": request.url.path, "auth": request.headers.get("authorization"), **body})
        return httpx.Response(200, json={"messages": [{"id": "wamid.abc"}]})


@pytest.fixture
def meta(services):
    from kritvia_api.services.whatsapp import WhatsAppClient
    fake = FakeMeta()
    wa = WhatsAppClient(APP_SECRET, VERIFY, transport=httpx.MockTransport(fake))
    old = services.whatsapp, services.messaging.whatsapp
    services.whatsapp = services.messaging.whatsapp = wa
    yield fake
    services.whatsapp, services.messaging.whatsapp = old


def signed(body: dict) -> tuple[bytes, dict[str, str]]:
    raw = json.dumps(body).encode()
    sig = "sha256=" + hmac.new(APP_SECRET.encode(), raw, hashlib.sha256).hexdigest()
    return raw, {"X-Hub-Signature-256": sig, "Content-Type": "application/json"}


def inbound(pnid: str, mid: str, text: str) -> dict:
    return {"object": "whatsapp_business_account", "entry": [{"id": "1", "changes": [{"field": "messages", "value": {
        "messaging_product": "whatsapp", "metadata": {"display_phone_number": "919876500000", "phone_number_id": pnid},
        "contacts": [{"profile": {"name": "Rahul"}, "wa_id": "919999988888"}],
        "messages": [{"from": "919999988888", "id": mid, "timestamp": "1700000000", "type": "text", "text": {"body": text}}]}}]}]}


async def test_whatsapp_connect_webhook_and_reply(shop, fake_llm, meta, client):
    mayank, approver, v = shop["mayank"], shop["approver"], shop["shop"]
    bad = await mayank.post(f"/ventures/{v}/connectors/whatsapp", json={"phone_number_id": "123bad", "access_token": "x" * 30})
    assert bad.status_code == 422
    r = await mayank.post(f"/ventures/{v}/connectors/whatsapp", json={"phone_number_id": "1234567890", "access_token": "EAAB" + "x" * 40})
    assert r.status_code == 201, r.text
    assert r.json()["display_phone_number"] == "+91 98765 00000" and r.json()["webhook_url"].endswith("/hooks/whatsapp")
    conns = (await mayank.get(f"/ventures/{v}/connectors")).json()
    assert any(c["provider"] == "whatsapp" and c["status"] == "active" for c in conns)
    # the token is never returned
    assert "EAAB" not in r.text and "EAAB" not in json.dumps(conns)

    # Meta's verification handshake
    ok = await client.get("/hooks/whatsapp", params={"hub.mode": "subscribe", "hub.verify_token": VERIFY, "hub.challenge": "42"})
    assert ok.status_code == 200 and ok.text == "42"
    no = await client.get("/hooks/whatsapp", params={"hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "42"})
    assert no.status_code == 403

    # unsigned and wrongly-signed payloads are refused; unknown numbers are ignored
    raw, headers = signed(inbound("1234567890", "wamid.in1", "Pune delivery kitna time?"))
    assert (await client.post("/hooks/whatsapp", content=raw)).status_code == 401
    assert (await client.post("/hooks/whatsapp", content=raw, headers={**headers, "X-Hub-Signature-256": "sha256=00"})).status_code == 401
    raw2, h2 = signed(inbound("000", "wamid.x", "hello"))
    assert (await client.post("/hooks/whatsapp", content=raw2, headers=h2)).json() == {"accepted": 0, "ignored": 1}

    script_inbox(fake_llm)
    res = await client.post("/hooks/whatsapp", content=raw, headers=headers)
    assert res.status_code == 200 and res.json()["accepted"] == 1, res.text
    # redelivery is deduped
    assert (await client.post("/hooks/whatsapp", content=raw, headers=headers)).json() == {"accepted": 0, "ignored": 1}

    runs = (await mayank.get(f"/ventures/{v}/runs", params={"workflow": "inbox_assistant"})).json()
    run = next(x for x in runs if x["trigger_kind"] == "whatsapp")
    assert run["status"] == "waiting"
    a = [x for x in (await approver.get("/approvals/inbox")).json() if x["run_id"] == run["id"]][0]
    assert a["action"] == "whatsapp.send" and a["payload"]["to"] == "919999988888"
    d = await approver.post(f"/ventures/{v}/approvals/{a['id']}/decision", json={"decision": "approve"})
    assert d.status_code == 200, d.text
    assert meta.sent and meta.sent[0]["to"] == "919999988888" and meta.sent[0]["path"].endswith("/1234567890/messages")
    assert meta.sent[0]["auth"].startswith("Bearer EAAB")
    run = (await mayank.get(f"/ventures/{v}/runs/{run['id']}")).json()
    assert run["outcome"] == "replied" and run["summary"]["sent"] == "sent"

    # outside the 24-hour window Meta refuses free text: the run fails with a clear reason, nothing is faked
    meta.fail = True
    raw3, h3 = signed(inbound("1234567890", "wamid.in2", "and Mumbai?"))
    await client.post("/hooks/whatsapp", content=raw3, headers=h3)
    run2 = next(x for x in (await mayank.get(f"/ventures/{v}/runs", params={"workflow": "inbox_assistant"})).json()
                if x["trigger_kind"] == "whatsapp" and x["id"] != run["id"])
    a2 = [x for x in (await approver.get("/approvals/inbox")).json() if x["run_id"] == run2["id"]][0]
    await approver.post(f"/ventures/{v}/approvals/{a2['id']}/decision", json={"decision": "approve"})
    run2 = (await mayank.get(f"/ventures/{v}/runs/{run2['id']}")).json()
    assert run2["status"] == "failed" and "24 hours" in (run2["error"] or "")

    # another business cannot claim the same number
    other = await shop["mallory"].post(f"/ventures/{shop['m_ven']}/connectors/whatsapp",
                                       json={"phone_number_id": "1234567890", "access_token": "EAAB" + "y" * 40})
    assert other.status_code == 409


async def test_message_with_an_id_number_stays_on_the_local_model(shop, fake_llm):
    """The Privacy Policy promises messages carrying ID, card or account numbers never reach a hosted model."""
    mayank, v = shop["mayank"], shop["shop"]
    script_inbox(fake_llm)
    fake_llm.calls.clear()
    mail = {**SUPPORT_MAIL, "body": "Hi, my PAN is ABCPE1234F, how long does delivery to Pune take? Rahul"}
    r = await mayank.post(f"/ventures/{v}/runs", json={"workflow": "inbox_assistant", "input": mail})
    assert r.status_code == 201, r.text
    chats = fake_llm.chat_calls("You sort the business's") + fake_llm.chat_calls("You answer the business's")
    assert len(chats) == 2 and {c["model"] for c in chats} == {"ollama-qwen-7b"}
