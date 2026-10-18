"""Run the business from Telegram or WhatsApp: a linked team member's messages and voice notes go to the
assistant as that person and the answer comes back in the chat; /today and /waiting; drafts arrive as
cards with buttons (WhatsApp only inside its 24-hour window); nobody unlinked gets any of it."""
from __future__ import annotations

import json
import uuid

import asyncpg
import httpx
import pytest

from conftest import ADMIN_DSN, join, make_actor
from test_inbox_assistant import APP_SECRET, VERIFY, signed
from test_chat_approvals import until
from test_telegram import send, update

TOKEN = "7011122233:AAH" + "d" * 32
BOT_ID = 7011122233
OWNER_CHAT = "771234111"
STRANGER_CHAT = "771234999"
PNID = "5550009999"
OWNER_PHONE = "919811100001"
MARK = "You are the business's assistant"


class FakeTelegram:
    """Bot API stand-in, with getFile and file downloads for voice notes."""
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.next_id = 900
        self.audio = b"OggS-fake-voice"

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.startswith("/file/bot"):
            assert path == f"/file/bot{TOKEN}/voice/file_7.oga"
            return httpx.Response(200, content=self.audio)
        token, method = path.removeprefix("/bot").split("/", 1)
        body = json.loads(request.content or b"{}")
        self.calls.append((method, body))
        if token != TOKEN:
            return httpx.Response(401, json={"ok": False, "error_code": 401, "description": "Unauthorized"})
        if method == "getMe":
            return httpx.Response(200, json={"ok": True, "result": {"id": BOT_ID, "is_bot": True, "first_name": "Desk",
                                                                    "username": "DeskSalonBot"}})
        if method == "getFile":
            return httpx.Response(200, json={"ok": True, "result": {"file_id": body["file_id"], "file_size": 2048,
                                                                    "file_path": "voice/file_7.oga"}})
        if method == "sendMessage":
            self.next_id += 1
            return httpx.Response(200, json={"ok": True, "result": {"message_id": self.next_id}})
        return httpx.Response(200, json={"ok": True, "result": True})

    def to(self, chat: str) -> list[str]:
        return [b["text"] for m, b in self.calls if m == "sendMessage" and str(b.get("chat_id")) == chat]

    def cards(self, chat: str) -> list[dict]:
        return [b for m, b in self.calls if m == "sendMessage" and str(b.get("chat_id")) == chat and b.get("reply_markup")]


class FakeMeta:
    """Graph API stand-in: number lookup, sends (text and buttons), and voice-note media."""
    def __init__(self) -> None:
        self.sent: list[dict] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            if request.url.host == "lookaside.fbsbx.com":
                assert request.headers["authorization"].startswith("Bearer EAAB")
                return httpx.Response(200, content=b"OggS-wa-voice")
            if request.url.path.endswith("/media-77"):
                return httpx.Response(200, json={"url": "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=77",
                                                 "mime_type": "audio/ogg; codecs=opus", "file_size": 3000})
            return httpx.Response(200, json={"display_phone_number": "+91 98765 00009", "verified_name": "Desk Salon"})
        body = json.loads(request.content)
        if body.get("status") == "read":
            return httpx.Response(200, json={"success": True})
        self.sent.append(body)
        return httpx.Response(200, json={"messages": [{"id": f"wamid.out{len(self.sent)}"}]})

    def to(self, phone: str) -> list[dict]:
        return [m for m in self.sent if m.get("to") == phone]


@pytest.fixture
def tg(services, monkeypatch):
    from kritvia_api.config import get_settings
    from kritvia_api.services.telegram import TelegramClient
    monkeypatch.setattr(get_settings(), "public_api_url", "https://api.example.test")
    monkeypatch.setattr(get_settings(), "public_web_url", "https://app.example.test")
    fake = FakeTelegram()
    client = TelegramClient(transport=httpx.MockTransport(fake))
    old = services.telegram, services.messaging.telegram
    services.telegram = services.messaging.telegram = client
    yield fake
    services.telegram, services.messaging.telegram = old


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
async def desk(world, client):
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Desk Salon", "slug": f"desk-{uuid.uuid4().hex[:6]}"})).json()["id"]
    await mayank.put(f"/ventures/{v}/settings", json={"kind": "general", "business_name": "Desk Salon", "city": "Pune"})
    owner = await make_actor(client, "desk-owner")
    await join(mayank, owner, world["org"], v, "venture_admin")
    approver = await make_actor(client, "desk-approver")
    await join(mayank, approver, world["org"], v, "approver")
    return {**world, "v": v, "owner": owner, "approver": approver}


def script(fake_llm, *steps):
    calls = {"n": 0}

    def reply(messages):
        i = min(calls["n"], len(steps) - 1)
        calls["n"] += 1
        s = steps[i]
        return s(messages) if callable(s) else s
    fake_llm.on(MARK, reply)


async def link_telegram(client, desk, tg) -> tuple[str, str]:
    mayank, owner, v = desk["mayank"], desk["owner"], desk["v"]
    r = await mayank.post(f"/ventures/{v}/connectors/telegram", json={"token": TOKEN})
    assert r.status_code == 201, r.text
    cid = r.json()["connector_id"]
    await owner.post(f"/ventures/{v}/approver-links/telegram")    # first link re-points the bot (buttons)
    secret = [b for m, b in tg.calls if m == "setWebhook"][-1]["secret_token"]
    code = (await owner.post(f"/ventures/{v}/approver-links/telegram")).json()["link"].split("start=")[1]
    await send(client, cid, secret, update(1, "/start " + code, chat=OWNER_CHAT, first="Asha"))
    assert "ask me anything about Desk Salon" in tg.to(OWNER_CHAT)[-1]
    return cid, secret


async def test_telegram_messages_voice_notes_and_reports_reach_the_business(desk, client, fake_llm, tg):
    owner, v = desk["owner"], desk["v"]
    cid, secret = await link_telegram(client, desk, tg)

    # a message goes to the assistant as the linked person; the answer comes back in the chat
    script(fake_llm, {"tool": "business.numbers", "args": {"period": "last_7_days"}},
           {"answer": "Is hafte ₹0 aaya, kuch baaki nahi."})
    r = await send(client, cid, secret, update(2, "Is hafte kitna paisa aaya?", chat=OWNER_CHAT))
    assert r.json() == {"accepted": 1, "ignored": 0}
    said = tg.to(OWNER_CHAT)
    assert "Is hafte ₹0 aaya, kuch baaki nahi." in said and "On it." in said
    mine = (await owner.get(f"/ventures/{v}/assistant")).json()
    assert mine[0]["request"] == "Is hafte kitna paisa aaya?" and mine[0]["answer"] == "Is hafte ₹0 aaya, kuch baaki nahi."
    assert (await desk["mayank"].get(f"/ventures/{v}/assistant")).json() == []      # it's the owner's own history

    # a voice note is transcribed, echoed, then handled like a message
    fake_llm.transcript = {"text": "aaj ke leads batao", "segments": []}
    script(fake_llm, {"answer": "Aaj koi naya lead nahi aaya."})
    voice = update(3, None, chat=OWNER_CHAT, extra={"voice": {"file_id": "AwACAgUAAx", "file_size": 2048, "duration": 3}})
    await send(client, cid, secret, voice)
    said = tg.to(OWNER_CHAT)
    assert "Heard: aaj ke leads batao" in said and "Aaj koi naya lead nahi aaya." in said
    assert (await owner.get(f"/ventures/{v}/assistant")).json()[0]["request"] == "aaj ke leads batao"

    # /today is the business's numbers, computed in code (no AI call)
    before = len(fake_llm.chat_calls())
    await send(client, cid, secret, update(4, "/today", chat=OWNER_CHAT))
    assert tg.to(OWNER_CHAT)[-1].startswith("Today:") and len(fake_llm.chat_calls()) == before
    # /help explains; a photo gets a short note
    await send(client, cid, secret, update(5, "/help", chat=OWNER_CHAT))
    assert "/today, /week, /waiting" in tg.to(OWNER_CHAT)[-1]
    await send(client, cid, secret, update(6, None, chat=OWNER_CHAT, extra={"photo": [{"file_id": "x"}]}))
    assert "messages and voice notes" in tg.to(OWNER_CHAT)[-1]

    # an approver who linked their chat decides drafts and sees numbers, but can't set work going
    code = (await desk["approver"].post(f"/ventures/{v}/approver-links/telegram")).json()["link"].split("start=")[1]
    await send(client, cid, secret, update(20, "/start " + code, chat="771234222"))
    await send(client, cid, secret, update(21, "Send Ravi a reminder", chat="771234222"))
    assert "needs an operator or admin role" in tg.to("771234222")[-1]
    await send(client, cid, secret, update(22, "/today", chat="771234222"))
    assert tg.to("771234222")[-1].startswith("Today:")

    # someone who isn't linked is a customer: nothing of the business reaches them
    script(fake_llm, {"answer": "SHOULD NOT BE SENT"})
    await send(client, cid, secret, update(7, "Is hafte kitna paisa aaya?", chat=STRANGER_CHAT))
    assert not any("SHOULD NOT" in t or t.startswith("Today") for t in tg.to(STRANGER_CHAT))


async def test_telegram_drafts_arrive_as_cards_and_waiting_sends_them_again(desk, client, fake_llm, tg):
    cid, secret = await link_telegram(client, desk, tg)
    script(fake_llm, {"tool": "tasks.create", "title": "Task: call Ravi", "args": {"title": "Call Ravi back"}},
           {"answer": "Added."})
    await send(client, cid, secret, update(10, "Ravi ko call karna hai, task bana do", chat=OWNER_CHAT))
    cards = await until(lambda: tg.cards(OWNER_CHAT))
    assert "Task: call Ravi" in cards[-1]["text"]
    approval = cards[-1]["reply_markup"]["inline_keyboard"][0][0]["callback_data"].split(":")[1]
    n = len(cards)
    await send(client, cid, secret, update(11, "/waiting", chat=OWNER_CHAT))
    assert any("waiting for your yes" in t for t in tg.to(OWNER_CHAT)[-3:])
    again = tg.cards(OWNER_CHAT)
    assert len(again) == n + 1 and approval in again[-1]["reply_markup"]["inline_keyboard"][0][0]["callback_data"]
    # an unlinked chat asking /waiting is a customer, not the owner
    await send(client, cid, secret, update(12, "/waiting", chat=STRANGER_CHAT))
    assert tg.cards(STRANGER_CHAT) == []


async def wa_hook(client, message: dict) -> dict:
    payload = {"object": "whatsapp_business_account", "entry": [{"id": "1", "changes": [{"field": "messages", "value": {
        "messaging_product": "whatsapp", "metadata": {"display_phone_number": "919876500009", "phone_number_id": PNID},
        "contacts": [{"profile": {"name": "Asha"}, "wa_id": message["from"]}], "messages": [message]}}]}]}
    raw, headers = signed(payload)
    r = await client.post("/hooks/whatsapp", content=raw, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def wa_text(mid: str, body: str, sender: str = OWNER_PHONE) -> dict:
    return {"from": sender, "id": mid, "timestamp": "1700000000", "type": "text", "text": {"body": body}}


async def test_whatsapp_link_ask_voice_and_approve_with_a_button(desk, client, fake_llm, meta):
    mayank, owner, v = desk["mayank"], desk["owner"], desk["v"]
    assert (await owner.post(f"/ventures/{v}/approver-links/whatsapp")).status_code == 409   # no number yet
    r = await mayank.post(f"/ventures/{v}/connectors/whatsapp", json={"phone_number_id": PNID, "access_token": "EAAB" + "w" * 40})
    assert r.status_code == 201, r.text
    out = (await owner.post(f"/ventures/{v}/approver-links/whatsapp")).json()
    assert out["number"] == "+919876500009" and out["link"].startswith("https://wa.me/919876500009?text=link_")
    code = out["link"].split("text=")[1]
    assert (await owner.get(f"/ventures/{v}/approver-links")).json()["whatsapp_number"] == "+91 98765 00009"

    # sending the code from the owner's phone links it
    await wa_hook(client, wa_text("wamid.l1", code))
    assert meta.to(OWNER_PHONE)[-1]["text"]["body"].startswith("Linked. Hi desk-owner")
    links = (await owner.get(f"/ventures/{v}/approver-links")).json()["links"]
    assert [(x["channel"], x["label"]) for x in links if x["channel"] == "whatsapp"] == [("whatsapp", "+" + OWNER_PHONE)]

    # asking: the answer comes back on WhatsApp
    script(fake_llm, {"answer": "Kal 3 bookings hain."})
    await wa_hook(client, wa_text("wamid.q1", "Kal kitni bookings hain?"))
    bodies = [m.get("text", {}).get("body") for m in meta.to(OWNER_PHONE)]
    assert "Kal 3 bookings hain." in bodies and "On it." in bodies

    # a voice note
    fake_llm.transcript = {"text": "pending kya hai", "segments": []}
    script(fake_llm, {"answer": "Kuch pending nahi."})
    await wa_hook(client, {"from": OWNER_PHONE, "id": "wamid.v1", "timestamp": "1700000001", "type": "audio",
                           "audio": {"id": "media-77", "mime_type": "audio/ogg; codecs=opus", "voice": True}})
    bodies = [m.get("text", {}).get("body") for m in meta.to(OWNER_PHONE)]
    assert "Heard: pending kya hai" in bodies and "Kuch pending nahi." in bodies

    # a draft arrives with reply buttons; pressing Approve decides it as the owner
    script(fake_llm, {"tool": "tasks.create", "title": "Task: order towels", "args": {"title": "Order towels"}},
           {"answer": "Done."})
    await wa_hook(client, wa_text("wamid.q2", "Towels order karne ka task bana do"))
    card = (await until(lambda: [m for m in meta.to(OWNER_PHONE) if m.get("type") == "interactive"]))[-1]
    buttons = card["interactive"]["action"]["buttons"]
    assert [b["reply"]["title"] for b in buttons] == ["Approve", "Reject", "Ask for changes"]
    assert "Task: order towels" in card["interactive"]["body"]["text"]
    approval_id = buttons[0]["reply"]["id"].split(":")[1]
    await wa_hook(client, {"from": OWNER_PHONE, "id": "wamid.b1", "timestamp": "1700000002", "type": "interactive",
                           "interactive": {"type": "button_reply", "button_reply": {"id": buttons[0]["reply"]["id"],
                                                                                    "title": "Approve"}}})
    a = (await owner.get(f"/ventures/{v}/approvals/{approval_id}")).json()
    assert a["status"] == "approved" and a["decided_by_email"] == owner.email

    # the owner's own messages never became customer chats
    chats = (await mayank.get(f"/ventures/{v}/whatsapp/chats")).json()["chats"]
    assert OWNER_PHONE not in {c["phone"] for c in chats}

    # outside WhatsApp's 24-hour window nothing is sent (cards wait in the app and other channels)
    admin = await asyncpg.connect(ADMIN_DSN)
    try:
        await admin.execute("UPDATE approver_links SET last_inbound_at = now() - interval '25 hours'"
                            " WHERE channel = 'whatsapp' AND external_id = $1", OWNER_PHONE)
    finally:
        await admin.close()
    from kritvia_api.services import front_door
    n = len(meta.sent)
    await front_door.reply(uuid.UUID(v), {"channel": "whatsapp", "chat": OWNER_PHONE, "user": str(owner.id)}, "late answer")
    assert len(meta.sent) == n
    # and an answer meant for someone else's link is never delivered
    await front_door.reply(uuid.UUID(v), {"channel": "whatsapp", "chat": OWNER_PHONE, "user": str(uuid.uuid4())}, "x")
    assert len(meta.sent) == n


async def test_a_code_from_someone_else_is_just_a_customer_message(desk, client, fake_llm, meta):
    stranger = "919811100099"
    r = await wa_hook(client, wa_text("wamid.s1", "link_" + "q" * 32, sender=stranger))
    assert r["accepted"] in (0, 1)
    links = (await desk["mayank"].get(f"/ventures/{desk['v']}/approver-links")).json()["links"]
    assert all(x.get("label") != "+" + stranger for x in links)


async def test_skills_are_listed_and_run_from_the_chat(desk, client, fake_llm, tg):
    owner, v = desk["owner"], desk["v"]
    cid, secret = await link_telegram(client, desk, tg)
    r = await owner.post(f"/ventures/{v}/skills", json={"name": "Daily summary", "trigger": "schedule", "freq": "daily",
                                                        "at_time": "19:00", "instructions": "1. Tell me today's numbers."})
    assert r.status_code == 201, r.text
    await send(client, cid, secret, update(30, "/skills", chat=OWNER_CHAT))
    assert "• Daily summary: Every day at 19:00" in tg.to(OWNER_CHAT)[-1]
    script(fake_llm, {"answer": "Aaj ₹0 aaya."})
    await send(client, cid, secret, update(31, "/run daily", chat=OWNER_CHAT))
    said = tg.to(OWNER_CHAT)
    assert 'Running "Daily summary".' in said and "Aaj ₹0 aaya." in said
    await send(client, cid, secret, update(32, "/run nothing-like-this", chat=OWNER_CHAT))
    assert tg.to(OWNER_CHAT)[-1].startswith("No skill by that name")
