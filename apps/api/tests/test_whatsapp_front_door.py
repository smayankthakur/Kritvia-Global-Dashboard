"""WhatsApp front door: one chat per customer, replies drafted with the chat in mind, enquiries become
leads, a person can take over (or is asked for), STOP opts out, the 24-hour window, and the team
answering from the WhatsApp page."""
from __future__ import annotations

import uuid

import httpx
import pytest
from sqlalchemy import text

from conftest import join, make_actor
from test_inbox_assistant import APP_SECRET, VERIFY, FakeMeta, signed

pytestmark = pytest.mark.asyncio

PNID = "5550001111"
CUSTOMER = "919811122233"


def msg(mid: str, body: str, *, sender: str = CUSTOMER, name: str = "Neha") -> dict:
    return {"object": "whatsapp_business_account", "entry": [{"id": "1", "changes": [{"field": "messages", "value": {
        "messaging_product": "whatsapp", "metadata": {"display_phone_number": "919876511111", "phone_number_id": PNID},
        "contacts": [{"profile": {"name": name}, "wa_id": sender}],
        "messages": [{"from": sender, "id": mid, "timestamp": "1700000000", "type": "text", "text": {"body": body}}]}}]}]}


def script(fake, *, category="enquiry", wants_person=False, reply="Ji, deep cleaning ₹2,000 se shuru hota hai."):
    fake.on("You sort the business's incoming messages", {
        "category": category, "summary": "Neha asks about kitchen deep cleaning.", "needs_reply": True,
        "language": "hinglish", "urgency": "medium", "wants_person": wants_person})
    fake.on("You answer the business's", {"subject": "", "body": reply, "used_sources": [], "unsure": False})


@pytest.fixture
def meta(services):
    from kritvia_api.services.whatsapp import WhatsAppClient
    fake = FakeMeta()
    wa = WhatsAppClient(APP_SECRET, VERIFY, transport=httpx.MockTransport(fake))
    old = services.whatsapp, services.messaging.whatsapp
    services.whatsapp = services.messaging.whatsapp = wa
    yield fake
    services.whatsapp, services.messaging.whatsapp = old


@pytest.fixture(scope="module")
async def cleaner(world, client):
    """A cleaning business with WhatsApp connected, the inbox assistant on, an approver and an operator."""
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Clean Co", "slug": f"clean-{uuid.uuid4().hex[:6]}"})).json()["id"]
    await mayank.put(f"/ventures/{v}/settings", json={"kind": "general", "business_name": "Clean Co", "city": "Delhi"})
    assert (await mayank.put(f"/ventures/{v}/workflow-configs/inbox_assistant",
                             json={"enabled": True, "settings": {}, "instructions": ""})).status_code == 200
    approver = await make_actor(client, "wa-approver")
    await join(mayank, approver, world["org"], v, "approver")
    operator = await make_actor(client, "wa-operator")
    await join(mayank, operator, world["org"], v, "operator")
    return {**world, "v": v, "approver": approver, "operator": operator}


async def hook(client, payload: dict) -> dict:
    raw, headers = signed(payload)
    r = await client.post("/hooks/whatsapp", content=raw, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


async def wa_runs(actor, v) -> list[dict]:
    return [x for x in (await actor.get(f"/ventures/{v}/runs", params={"workflow": "inbox_assistant"})).json()
            if x["trigger_kind"] == "whatsapp"]


async def approve_latest(approver, v, run_id) -> None:
    a = [x for x in (await approver.get("/approvals/inbox")).json() if x["run_id"] == run_id][0]
    r = await approver.post(f"/ventures/{v}/approvals/{a['id']}/decision", json={"decision": "approve"})
    assert r.status_code == 200, r.text


async def test_chat_is_kept_and_the_next_reply_sees_it(cleaner, client, fake_llm, meta):
    mayank, approver, v = cleaner["mayank"], cleaner["approver"], cleaner["v"]
    r = await mayank.post(f"/ventures/{v}/connectors/whatsapp", json={"phone_number_id": PNID, "access_token": "EAAB" + "c" * 40})
    assert r.status_code == 201, r.text
    script(fake_llm)
    assert (await hook(client, msg("wamid.c1", "Kitchen deep cleaning karte ho?")))["accepted"] == 1
    run1 = (await wa_runs(mayank, v))[0]
    assert run1["status"] == "waiting"
    # an enquiry on WhatsApp becomes a lead and stays in the chat (no hand-off to Lead triage)
    assert run1["summary"].get("lead_id")
    leads = (await mayank.get(f"/ventures/{v}/leads")).json()
    lead = next(x for x in leads if x["id"] == run1["summary"]["lead_id"])
    assert lead["source"] == "whatsapp" and lead["name"] == "Neha"
    await approve_latest(approver, v, run1["id"])
    assert meta.sent[-1]["to"] == CUSTOMER

    # the next message's draft is written with the chat so far
    script(fake_llm, reply="Sunday ko bhi available hain.")
    await hook(client, msg("wamid.c2", "Sunday ko aa sakte ho?"))
    drafts = fake_llm.chat_calls("You answer the business's")
    assert "The chat so far" in drafts[-1]["prompt"]
    assert "Kitchen deep cleaning karte ho?" in drafts[-1]["prompt"] and "₹2,000" in drafts[-1]["prompt"]

    chats = (await mayank.get(f"/ventures/{v}/whatsapp/chats")).json()
    assert chats["connected"] is True
    chat = next(c for c in chats["chats"] if c["phone"] == CUSTOMER)
    assert chat["name"] == "Neha" and chat["unread"] == 2 and chat["window_open"] is True
    assert chat["last_message"] == "Sunday ko aa sakte ho?" and chat["last_direction"] == "in"
    assert chat["lead_id"] == lead["id"]
    # the reply drafted for the second message waits for a yes, and the chat says so
    pending = (await approver.get(f"/ventures/{v}/approvals")).json()
    assert chat["pending_approval_id"] in {x["id"] for x in pending}
    detail = (await approver.get(f"/ventures/{v}/whatsapp/chats/{chat['id']}")).json()
    assert [(m["direction"], m["sent_by"]) for m in detail["messages"]] == \
        [("in", "customer"), ("out", "kritvia"), ("in", "customer")]
    assert detail["chat"]["unread"] == 0      # reading clears it, even for a read-only approver
    again = (await mayank.get(f"/ventures/{v}/whatsapp/chats")).json()
    assert next(c for c in again["chats"] if c["id"] == chat["id"])["unread"] == 0
    # redelivery of a stored message is ignored
    assert (await hook(client, msg("wamid.c2", "Sunday ko aa sakte ho?"))) == {"accepted": 0, "ignored": 1}

    # she writes again before anyone approves: the new draft answers both, the earlier one is withdrawn
    script(fake_llm, reply="Ji, Sunday 11 baje aa sakte hain, 2BHK ke ₹2,000.")
    await hook(client, msg("wamid.c3", "Aur 2BHK ka total kitna?"))
    runs = {x["trigger_ref"] if "trigger_ref" in x else x["id"]: x for x in await wa_runs(mayank, v)}
    statuses = sorted(x["status"] for x in runs.values() if x["id"] != run1["id"])
    assert statuses == ["cancelled", "waiting"], statuses
    pending = (await approver.get(f"/ventures/{v}/approvals")).json()
    mine = [a for a in pending if a["action"] == "whatsapp.send" and a["payload"]["to"] == CUSTOMER]
    assert len(mine) == 1 and "Sunday 11 baje" in mine[0]["payload"]["body"]


async def test_only_the_latest_of_several_messages_is_answered(cleaner, services, fake_llm):
    from kritvia_api.db.session import tenant_tx
    from kritvia_api.engine.runner import start_run
    from kritvia_api.services import wa_inbox
    from kritvia_api.services.crypto import EnvelopeCrypto
    from kritvia_api.workflows.inbox import message_input
    v = uuid.UUID(cleaner["v"])
    async with tenant_tx(None, "system") as conn:
        p = (await conn.execute(text("SELECT * FROM private.whatsapp_principal(:p)"), {"p": PNID})).first()
    async with tenant_tx(p.run_as, "agent", "whatsapp") as conn:
        for mid, body in (("wamid.b1", "Hello"), ("wamid.b2", "Rate kya hai?")):
            await wa_inbox.record_inbound(conn, EnvelopeCrypto(conn, services.keys), org_id=p.org_id, venture_id=v,
                                          phone="919800000001", name="Amit", body=body, kind="text", provider_id=mid)
    async with tenant_tx(p.run_as, "agent", "whatsapp") as conn:
        assert await wa_inbox.newer_inbound(conn, v, "919800000001", "wamid.b1") is True
        assert await wa_inbox.newer_inbound(conn, v, "919800000001", "wamid.b2") is False
    script(fake_llm)
    run_id = await start_run(services, actor_user_id=p.run_as, actor_type="agent", venture_id=v,
                             workflow="inbox_assistant", trigger_kind="whatsapp", trigger_ref="wamid.b1",
                             input=message_input(channel="whatsapp", from_name="Amit", from_phone="919800000001",
                                                 subject=None, body="Hello", message_id="wamid.b1"))
    run = (await cleaner["mayank"].get(f"/ventures/{v}/runs/{run_id}")).json()
    assert run["outcome"] == "superseded" and run["status"] == "completed"


async def test_a_customer_who_asks_for_a_person_is_handed_over(cleaner, client, fake_llm, meta):
    mayank, operator, v = cleaner["mayank"], cleaner["operator"], cleaner["v"]
    sender = "919822233344"
    script(fake_llm, category="support", wants_person=True)
    await hook(client, msg("wamid.p1", "Mujhe owner se baat karni hai, complaint hai", sender=sender, name="Ravi"))
    run = next(x for x in await wa_runs(mayank, v) if "Ravi" in x["title"])
    assert run["outcome"] == "handed_to_person"
    chat = next(c for c in (await mayank.get(f"/ventures/{v}/whatsapp/chats")).json()["chats"] if c["phone"] == sender)
    assert chat["handled_by"] == "person" and chat["handoff_reason"]

    # while a person has the chat, new messages are kept but nothing is drafted
    before = len(await wa_runs(mayank, v))
    assert (await hook(client, msg("wamid.p2", "Hello??", sender=sender, name="Ravi")))["accepted"] == 1
    assert len(await wa_runs(mayank, v)) == before
    detail = (await mayank.get(f"/ventures/{v}/whatsapp/chats/{chat['id']}")).json()
    assert detail["messages"][-1]["body"] == "Hello??"

    # the operator answers from the WhatsApp page, then gives the chat back to Kritvia
    r = await operator.post(f"/ventures/{v}/whatsapp/chats/{chat['id']}/reply", json={"body": "Ravi ji, main Mayank. Batayiye?"})
    assert r.status_code == 201, r.text
    assert r.json()["sent_by"] == "person" and r.json()["status"] == "sent"
    assert meta.sent[-1]["to"] == sender and meta.sent[-1]["text"]["body"].startswith("Ravi ji")
    back = await operator.put(f"/ventures/{v}/whatsapp/chats/{chat['id']}/handler", json={"handled_by": "kritvia"})
    assert back.status_code == 200 and back.json()["handled_by"] == "kritvia" and back.json()["handoff_reason"] is None
    script(fake_llm, category="support")
    await hook(client, msg("wamid.p3", "Thik hai, thanks", sender=sender, name="Ravi"))
    assert len(await wa_runs(mayank, v)) == before + 1


async def test_a_person_replying_takes_the_chat_over(cleaner, client, fake_llm, meta):
    mayank, operator, approver, v = cleaner["mayank"], cleaner["operator"], cleaner["approver"], cleaner["v"]
    sender = "919833344455"
    script(fake_llm)
    await hook(client, msg("wamid.t1", "Price list bhejo", sender=sender, name="Sana"))
    chat = next(c for c in (await mayank.get(f"/ventures/{v}/whatsapp/chats")).json()["chats"] if c["phone"] == sender)
    assert chat["handled_by"] == "kritvia"
    # a read-only approver can read the chat but not answer it
    assert (await approver.post(f"/ventures/{v}/whatsapp/chats/{chat['id']}/reply", json={"body": "hi"})).status_code == 403
    assert (await approver.put(f"/ventures/{v}/whatsapp/chats/{chat['id']}/handler",
                               json={"handled_by": "person"})).status_code == 403
    r = await operator.post(f"/ventures/{v}/whatsapp/chats/{chat['id']}/reply", json={"body": "Bhej raha hoon"})
    assert r.status_code == 201
    chat = (await mayank.get(f"/ventures/{v}/whatsapp/chats/{chat['id']}")).json()["chat"]
    assert chat["handled_by"] == "person" and chat["handoff_reason"] == "A person replied"


async def test_stop_opts_the_customer_out(cleaner, client, fake_llm, meta):
    mayank, v = cleaner["mayank"], cleaner["v"]
    sender = "919844455566"
    before = len(await wa_runs(mayank, v))
    assert (await hook(client, msg("wamid.s1", "STOP", sender=sender, name="Kiran")))["accepted"] == 1
    assert len(await wa_runs(mayank, v)) == before
    chat = next(c for c in (await mayank.get(f"/ventures/{v}/whatsapp/chats")).json()["chats"] if c["phone"] == sender)
    assert chat["opted_out"] is True
    r = await mayank.post(f"/ventures/{v}/whatsapp/chats/{chat['id']}/reply", json={"body": "Sorry!"})
    assert r.status_code == 409 and "STOP" in r.json()["detail"]


async def test_nothing_is_sent_outside_the_24_hour_window(cleaner, client, fake_llm, meta, monkeypatch):
    from kritvia_api.services import wa_inbox
    mayank, approver, v = cleaner["mayank"], cleaner["approver"], cleaner["v"]
    sender = "919855566677"
    script(fake_llm, category="support")
    await hook(client, msg("wamid.w1", "Kal subah aa jaoge?", sender=sender, name="Tara"))
    run = next(x for x in await wa_runs(mayank, v) if "Tara" in x["title"])
    sent_before = len(meta.sent)
    monkeypatch.setattr(wa_inbox, "window_open", lambda *_a, **_k: False)
    chat = next(c for c in (await mayank.get(f"/ventures/{v}/whatsapp/chats")).json()["chats"] if c["phone"] == sender)
    assert chat["window_open"] is False
    r = await mayank.post(f"/ventures/{v}/whatsapp/chats/{chat['id']}/reply", json={"body": "Ji"})
    assert r.status_code == 409 and "24 hours" in r.json()["detail"]
    await approve_latest(approver, v, run["id"])
    run = (await mayank.get(f"/ventures/{v}/runs/{run['id']}")).json()
    assert run["status"] == "failed" and "24 hours" in (run["error"] or "")
    assert len(meta.sent) == sent_before            # Meta was never asked
    detail = (await mayank.get(f"/ventures/{v}/whatsapp/chats/{chat['id']}")).json()
    assert detail["messages"][-1]["status"] == "failed"


async def test_chats_are_private_and_only_admins_delete(cleaner):
    mayank, mallory, operator, v = cleaner["mayank"], cleaner["mallory"], cleaner["operator"], cleaner["v"]
    chat = (await mayank.get(f"/ventures/{v}/whatsapp/chats")).json()["chats"][0]
    assert (await mallory.get(f"/ventures/{v}/whatsapp/chats")).status_code == 404
    assert (await mallory.get(f"/ventures/{v}/whatsapp/chats/{chat['id']}")).status_code == 404
    assert (await mallory.post(f"/ventures/{v}/whatsapp/chats/{chat['id']}/reply", json={"body": "x"})).status_code == 404
    # a chat id from another business is not found through this business
    assert (await mallory.get(f"/ventures/{cleaner['m_ven']}/whatsapp/chats/{chat['id']}")).status_code == 404
    assert (await operator.delete(f"/ventures/{v}/whatsapp/chats/{chat['id']}")).status_code == 403
    assert (await mayank.delete(f"/ventures/{v}/whatsapp/chats/{chat['id']}")).status_code == 204
    assert (await mayank.get(f"/ventures/{v}/whatsapp/chats/{chat['id']}")).status_code == 404
