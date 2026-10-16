"""Approve from your phone: team members link their Telegram chat (through the business's bot) or Slack
account (through Kritvia's Slack app); drafts that need their yes arrive there with Approve, Reject and
Ask for changes, decided as that person with the app's own role checks."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import time
import uuid
from urllib.parse import parse_qs, urlencode, urlsplit

import asyncpg
import httpx
import pytest

from conftest import ADMIN_DSN, join, make_actor
from test_telegram import send, tg_runs, update
from test_whatsapp_front_door import script

pytestmark = pytest.mark.asyncio

TOKEN = "7098765432:AAH" + "z" * 32
BOT_ID = 7098765432
CUSTOMER = "661234000"
CUSTOMER2 = "661234333"
APPROVER_CHAT = "661234111"
OPERATOR_CHAT = "661234222"
SIGNING = "s" * 32
TEAM = "T0KRITVIA1"
# Built from parts so the test never contains a whole webhook address (secret scanners flag those).
HOOK = "https://" + "hooks.slack." + "com/services/" + "/".join(("T0KRITVIA1", "B0KRITVIA2", "q" * 24))


class FakeTelegram:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.next_id = 500

    def __call__(self, request: httpx.Request) -> httpx.Response:
        token, method = request.url.path.removeprefix("/bot").split("/", 1)
        body = json.loads(request.content or b"{}")
        self.calls.append((method, body))
        if token != TOKEN:
            return httpx.Response(401, json={"ok": False, "error_code": 401, "description": "Unauthorized"})
        if method == "getMe":
            return httpx.Response(200, json={"ok": True, "result": {"id": BOT_ID, "is_bot": True, "first_name": "Glow",
                                                                    "username": "GlowSalonBot"}})
        if method == "sendMessage":
            self.next_id += 1
            return httpx.Response(200, json={"ok": True, "result": {"message_id": self.next_id}})
        return httpx.Response(200, json={"ok": True, "result": True})

    def to(self, chat: str, method: str = "sendMessage") -> list[dict]:
        return [b for m, b in self.calls if m == method and str(b.get("chat_id")) == chat]

    def last(self, method: str) -> dict:
        return [b for m, b in self.calls if m == method][-1]


class FakeSlackApi:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.ts = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if request.url.host.startswith("hooks."):
            self.calls.append(("webhook", json.loads(request.content)))
            return httpx.Response(200, text="ok")
        method = request.url.path.rsplit("/", 1)[-1]
        ctype = request.headers.get("content-type", "")
        body = json.loads(request.content) if "json" in ctype else {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
        self.calls.append((method, body))
        if method == "oauth.v2.access":
            assert request.headers["authorization"].startswith("Basic ") and body["code"] == "good-code", url
            return httpx.Response(200, json={
                "ok": True, "access_token": "xoxb-" + "1" * 20, "scope": "chat:write,im:write,incoming-webhook",
                "team": {"id": TEAM, "name": "Glow Team"}, "authed_user": {"id": "U0OWNER"},
                "incoming_webhook": {"url": HOOK, "channel": "#salon"}})
        if request.headers.get("authorization") != "Bearer xoxb-" + "1" * 20:
            return httpx.Response(200, json={"ok": False, "error": "invalid_auth"})
        if method == "users.lookupByEmail":
            if body["email"].startswith("chat-approver"):
                return httpx.Response(200, json={"ok": True, "user": {"id": "U0APPROVER", "real_name": "Asha"}})
            return httpx.Response(200, json={"ok": False, "error": "users_not_found"})
        if method == "chat.postMessage":
            self.ts += 1
            return httpx.Response(200, json={"ok": True, "channel": "D" + body["channel"][1:], "ts": f"17000.{self.ts}"})
        return httpx.Response(200, json={"ok": True})

    def of(self, method: str) -> list[dict]:
        return [b for m, b in self.calls if m == method]


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
def slack_app(services, monkeypatch):
    from kritvia_api.config import get_settings
    from kritvia_api.services.slack import SlackClient
    s = get_settings()
    for k, v in (("slack_client_id", "123.456"), ("slack_client_secret", "c" * 32), ("slack_signing_secret", SIGNING),
                 ("public_web_url", "https://app.example.test")):
        monkeypatch.setattr(s, k, v)
    fake = FakeSlackApi()
    old = services.slack
    services.slack = SlackClient(transport=httpx.MockTransport(fake))
    yield fake
    services.slack = old


@pytest.fixture(scope="module")
async def salon(world, client):
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Glow Salon", "slug": f"glow-{uuid.uuid4().hex[:6]}"})).json()["id"]
    await mayank.put(f"/ventures/{v}/settings", json={"kind": "general", "business_name": "Glow Salon", "city": "Pune"})
    assert (await mayank.put(f"/ventures/{v}/workflow-configs/inbox_assistant",
                             json={"enabled": True, "settings": {}, "instructions": ""})).status_code == 200
    approver = await make_actor(client, "chat-approver")
    await join(mayank, approver, world["org"], v, "approver")
    operator = await make_actor(client, "chat-operator")
    await join(mayank, operator, world["org"], v, "operator")
    return {**world, "v": v, "approver": approver, "operator": operator}


async def until(check, tries: int = 100):
    for _ in range(tries):
        out = check()
        if out:
            return out
        await asyncio.sleep(0.02)
    raise AssertionError("timed out")


def press(chat: str, data: str, n: int) -> dict:
    return {"update_id": 990000 + n, "callback_query": {
        "id": f"cb{n}", "data": data, "from": {"id": int(chat), "is_bot": False, "first_name": "Asha"},
        "message": {"message_id": 1, "chat": {"id": int(chat), "type": "private"}}}}


async def test_telegram_link_card_and_buttons(salon, client, fake_llm, tg):
    mayank, approver, operator, v = salon["mayank"], salon["approver"], salon["operator"], salon["v"]
    # nothing to link to until the business has a bot
    assert (await approver.post(f"/ventures/{v}/approver-links/telegram")).status_code == 409
    r = await mayank.post(f"/ventures/{v}/connectors/telegram", json={"token": TOKEN})
    assert r.status_code == 201, r.text
    cid = r.json()["connector_id"]
    secret = next(b for m, b in tg.calls if m == "setWebhook")["secret_token"]

    # a bot connected before buttons existed is re-pointed (fresh secret) the first time someone links
    admin = await asyncpg.connect(ADMIN_DSN)
    try:
        await admin.execute("UPDATE connectors SET meta = meta - 'buttons' WHERE id = $1", uuid.UUID(cid))
    finally:
        await admin.close()
    out = (await approver.post(f"/ventures/{v}/approver-links/telegram")).json()
    assert tg.last("setWebhook")["secret_token"] != secret
    assert (await send(client, cid, secret, update(1, "Hi", chat=APPROVER_CHAT))).status_code == 401
    secret = tg.last("setWebhook")["secret_token"]
    await approver.post(f"/ventures/{v}/approver-links/telegram")
    assert tg.last("setWebhook")["secret_token"] == secret             # only once
    out = (await approver.post(f"/ventures/{v}/approver-links/telegram")).json()
    assert out["bot"] == "@GlowSalonBot" and out["link"].startswith("https://t.me/GlowSalonBot?start=link_")
    code = out["link"].split("start=")[1]
    # a wrong code links nobody
    r = await send(client, cid, secret, update(1, "/start link_" + "x" * 32, chat=APPROVER_CHAT))
    assert r.json() == {"accepted": 1, "ignored": 0}
    assert "expired" in tg.to(APPROVER_CHAT)[-1]["text"]
    await send(client, cid, secret, update(2, "/start " + code, chat=APPROVER_CHAT, first="Asha"))
    assert tg.to(APPROVER_CHAT)[-1]["text"].startswith("Linked. Hi chat-approver")
    # the code works once
    await send(client, cid, secret, update(3, "/start " + code, chat=OPERATOR_CHAT))
    assert "expired" in tg.to(OPERATOR_CHAT)[-1]["text"]
    links = (await approver.get(f"/ventures/{v}/approver-links")).json()
    assert links["telegram_bot"] == "@GlowSalonBot"
    assert [(x["channel"], x["mine"], x["label"]) for x in links["links"]] == [("telegram", True, "@neha_k")]
    # the operator sees no one else's link; the admin sees all
    assert (await operator.get(f"/ventures/{v}/approver-links")).json()["links"] == []
    assert len((await mayank.get(f"/ventures/{v}/approver-links")).json()["links"]) == 1
    # the operator links too (decisions stay theirs: they can't approve)
    code2 = (await operator.post(f"/ventures/{v}/approver-links/telegram")).json()["link"].split("start=")[1]
    await send(client, cid, secret, update(4, "/start " + code2, chat=OPERATOR_CHAT))

    # a customer's message: the draft reaches the approver's chat with buttons, not the operator's
    script(fake_llm, reply="Hi! A haircut is ₹400.")
    assert (await send(client, cid, secret, update(10, "Haircut price?", chat=CUSTOMER))).json()["accepted"] == 1
    card = await until(lambda: [b for b in tg.to(APPROVER_CHAT) if "reply_markup" in b and
                                b["reply_markup"].get("inline_keyboard")])
    card = card[-1]
    assert "A draft needs your yes · Glow Salon" in card["text"] and "₹400" in card["text"]
    keys = card["reply_markup"]["inline_keyboard"]
    approval = keys[0][0]["callback_data"].split(":")[1]
    assert [b["text"] for row in keys for b in row] == ["Approve", "Reject", "Ask for changes", "Open in Kritvia"]
    assert not [b for b in tg.to(OPERATOR_CHAT) if "reply_markup" in b]

    # someone who isn't linked can't press it; the operator is linked but may not decide
    await send(client, cid, secret, press("123123", f"a:{approval}:y", 1))
    assert "isn't linked" in tg.last("answerCallbackQuery")["text"]
    await send(client, cid, secret, press(OPERATOR_CHAT, f"a:{approval}:y", 2))
    assert "can't decide" in tg.last("answerCallbackQuery")["text"]
    assert (await approver.get(f"/ventures/{v}/approvals/{approval}")).json()["status"] == "pending"

    # Approve: decided as the approver, the reply goes out, the card says so and loses its buttons
    await send(client, cid, secret, press(APPROVER_CHAT, f"a:{approval}:y", 3))
    a = (await approver.get(f"/ventures/{v}/approvals/{approval}")).json()
    assert a["status"] in ("approved", "executed") and a["decided_by_email"] == approver.email
    assert tg.to(CUSTOMER)[-1]["text"] == "Hi! A haircut is ₹400."
    edit = await until(lambda: tg.to(APPROVER_CHAT, "editMessageText"))
    assert edit[-1]["text"].startswith("Approved by chat-approver") and edit[-1]["reply_markup"] == {"inline_keyboard": []}
    # pressing again: already decided
    await send(client, cid, secret, press(APPROVER_CHAT, f"a:{approval}:n", 4))
    assert "already decided" in tg.last("answerCallbackQuery")["text"]

    # Ask for changes: the next message is the note, the draft goes back and is redone
    script(fake_llm, reply="Hello! Haircut ₹400.")
    await send(client, cid, secret, update(11, "Kal ka slot?", chat=CUSTOMER))
    card = await until(lambda: [b for b in tg.to(APPROVER_CHAT) if b.get("reply_markup", {}).get("inline_keyboard")
                                and "Kal" not in b["text"] and b is not card])
    second = card[-1]["reply_markup"]["inline_keyboard"][0][0]["callback_data"].split(":")[1]
    assert second != approval
    await send(client, cid, secret, press(APPROVER_CHAT, f"a:{second}:c", 5))
    assert tg.to(APPROVER_CHAT)[-1]["text"].startswith("What should change?")
    script(fake_llm, reply="Hello! Haircut ₹400, and yes, tomorrow 11 am is free.")
    runs_before = len(await tg_runs(mayank, v))
    await send(client, cid, secret, update(12, "Mention tomorrow 11 am is free", chat=APPROVER_CHAT))
    a = (await approver.get(f"/ventures/{v}/approvals/{second}")).json()
    assert a["status"] == "rejected" and a["comment"] == "Mention tomorrow 11 am is free"
    assert "goes back to be redone" in tg.to(APPROVER_CHAT)[-1]["text"] or \
        "already" in tg.to(APPROVER_CHAT)[-1]["text"]
    assert len(await tg_runs(mayank, v)) == runs_before            # same run, redrafted
    # the approver's own messages never became customer chats
    chats = (await mayank.get(f"/ventures/{v}/whatsapp/chats")).json()["chats"]
    assert {c["phone"] for c in chats if c["channel"] == "telegram"} == {CUSTOMER}

    # any other message from a linked person gets a short note
    await send(client, cid, secret, update(13, "hello?", chat=APPROVER_CHAT))
    assert "You approve drafts for Glow Salon here" in tg.to(APPROVER_CHAT)[-1]["text"]

    # unlink: the chat is a stranger again (a press does nothing)
    mine = (await approver.get(f"/ventures/{v}/approver-links")).json()["links"][0]
    assert (await operator.delete(f"/ventures/{v}/approver-links/{mine['id']}")).status_code == 404
    assert (await approver.delete(f"/ventures/{v}/approver-links/{mine['id']}")).status_code == 204
    await send(client, cid, secret, press(APPROVER_CHAT, f"a:{second}:y", 6))
    assert "isn't linked" in tg.last("answerCallbackQuery")["text"]


def signed(body: bytes, *, ts: int | None = None, secret: str = SIGNING) -> dict:
    ts = ts or int(time.time())
    mac = hmac.new(secret.encode(), f"v0:{ts}:".encode() + body, hashlib.sha256).hexdigest()
    return {"x-slack-request-timestamp": str(ts), "x-slack-signature": "v0=" + mac,
            "content-type": "application/x-www-form-urlencoded"}


async def interact(client, payload: dict, **kw) -> httpx.Response:
    body = urlencode({"payload": json.dumps(payload)}).encode()
    return await client.post("/hooks/slack/interact", content=body, headers=signed(body, **kw))


def action(user: str, action_id: str, value: str) -> dict:
    return {"type": "block_actions", "team": {"id": TEAM}, "user": {"id": user, "username": user.lower()},
            "trigger_id": "trig.1", "channel": {"id": "D" + user[1:]},
            "container": {"channel_id": "D" + user[1:], "message_ts": "17000.1"},
            "actions": [{"action_id": action_id, "value": value}]}


async def test_slack_app_install_link_and_buttons(salon, client, fake_llm, tg, slack_app, world):
    from kritvia_api.services.slack import verify_signature
    mayank, approver, operator, v = salon["mayank"], salon["approver"], salon["operator"], salon["v"]
    assert verify_signature(SIGNING, "100", b"x", "v0=bad", now=100) is False
    assert (await approver.post(f"/ventures/{v}/approver-links/slack")).status_code == 409

    # Add to Slack: admins only, bound to the browser's nonce and the user who started it
    nonce = "n" * 40
    assert (await operator.post(f"/ventures/{v}/connectors/slack/install", json={"nonce": nonce})).status_code == 404
    r = await mayank.post(f"/ventures/{v}/connectors/slack/install", json={"nonce": nonce})
    assert r.status_code == 200, r.text
    q = parse_qs(urlsplit(r.json()["url"]).query)
    assert q["client_id"] == ["123.456"] and "users:read.email" in q["scope"][0]
    state = q["state"][0]
    bad = await mayank.post("/connectors/slack/complete", json={"code": "good-code", "state": state, "nonce": "m" * 40})
    assert bad.status_code == 403
    assert (await approver.post("/connectors/slack/complete",
                                json={"code": "good-code", "state": state, "nonce": nonce})).status_code == 403
    r = await mayank.post("/connectors/slack/complete", json={"code": "good-code", "state": state, "nonce": nonce})
    assert r.status_code == 200, r.text
    assert r.json()["team"] == "Glow Team" and r.json()["channel"] == "#salon"
    links = (await mayank.get(f"/ventures/{v}/approver-links")).json()
    assert links["slack_app"] is True and links["slack_available"] is True
    assert [(x["channel"], x["mine"]) for x in links["links"] if x["channel"] == "slack"] == [("slack", True)]
    conn = next(c for c in (await mayank.get(f"/ventures/{v}/connectors")).json() if c["provider"] == "slack")
    assert "xoxb" not in json.dumps(conn)

    # the approver links by email: a DM with a Link button; only pressing it (as them) links
    r = await approver.post(f"/ventures/{v}/approver-links/slack")
    assert r.status_code == 200 and r.json()["sent_to"] == "Asha"
    assert slack_app.of("users.lookupByEmail")[-1]["email"] == approver.email
    dm = slack_app.of("chat.postMessage")[-1]
    value = dm["blocks"][1]["elements"][0]["value"]
    assert dm["channel"] == "U0APPROVER" and value.startswith(v + ":")
    assert (await operator.post(f"/ventures/{v}/approver-links/slack")).status_code == 422   # no such Slack member
    # unsigned, badly signed or stale requests are refused
    body = urlencode({"payload": json.dumps(action("U0APPROVER", "kv_link", value))}).encode()
    assert (await client.post("/hooks/slack/interact", content=body,
                              headers={"content-type": "application/x-www-form-urlencoded"})).status_code == 401
    assert (await interact(client, action("U0APPROVER", "kv_link", value), secret="w" * 32)).status_code == 401
    assert (await interact(client, action("U0APPROVER", "kv_link", value), ts=int(time.time()) - 600)).status_code == 401
    assert (await interact(client, action("U0APPROVER", "kv_link", value))).status_code == 200
    assert slack_app.of("chat.update")[-1]["text"].startswith("Linked.")
    people = {x["person"] for x in (await mayank.get(f"/ventures/{v}/approver-links")).json()["links"]
              if x["channel"] == "slack"}
    assert len(people) == 2 and "chat-approver" in people

    # a draft: DMs to both linked people, with buttons; the channel still hears the notice
    before = len(slack_app.of("chat.postMessage"))
    script(fake_llm, reply="Facial is ₹900.")
    cid = (await mayank.post(f"/ventures/{v}/connectors/telegram", json={"token": TOKEN})).json()["connector_id"]
    secret = tg.last("setWebhook")["secret_token"]
    r = await send(client, cid, secret, update(30, "Facial price?", chat=CUSTOMER2, first="Ritu", username=None))
    assert r.json()["accepted"] == 1, r.text
    await until(lambda: len([b for b in slack_app.of("chat.postMessage")[before:]
                             if len(b.get("blocks", [{}, {"elements": []}])[1]["elements"]) == 4]) >= 2)
    cards = [b for b in slack_app.of("chat.postMessage")[before:] if len(b["blocks"][1]["elements"]) == 4]
    assert {c["channel"] for c in cards} == {"U0OWNER", "U0APPROVER"}
    assert "Facial is ₹900." in cards[0]["blocks"][0]["text"]["text"]
    assert [e["action_id"] for e in cards[0]["blocks"][1]["elements"]] == ["kv_yes", "kv_no", "kv_change", "kv_open"]
    value = cards[0]["blocks"][1]["elements"][0]["value"]
    approval = value.split(":")[1]
    await until(lambda: slack_app.of("webhook"))

    # a stranger in the workspace can't decide
    await interact(client, action("U0STRANGER", "kv_yes", value))
    assert "isn't linked" in slack_app.of("chat.postEphemeral")[-1]["text"]
    # a press from another workspace is ignored
    other = action("U0APPROVER", "kv_yes", value) | {"team": {"id": "T0OTHER"}}
    await interact(client, other)
    assert (await approver.get(f"/ventures/{v}/approvals/{approval}")).json()["status"] == "pending"

    # Ask for changes opens a form; submitting it sends the draft back with the note
    await interact(client, action("U0APPROVER", "kv_change", value))
    view = slack_app.of("views.open")[-1]
    assert view["trigger_id"] == "trig.1" and view["view"]["private_metadata"] == value
    sub = {"type": "view_submission", "team": {"id": TEAM}, "user": {"id": "U0APPROVER"},
           "view": {"callback_id": "kv_change", "private_metadata": value,
                    "state": {"values": {"change": {"note": {"type": "plain_text_input", "value": ""}}}}}}
    r = await interact(client, sub)
    assert r.json()["response_action"] == "errors"
    script(fake_llm, reply="Facial is ₹900; we're open till 8 pm.")
    sub["view"]["state"]["values"]["change"]["note"]["value"] = "Say we're open till 8"
    r = await interact(client, sub)
    assert r.status_code == 200 and r.content == b""
    a = (await approver.get(f"/ventures/{v}/approvals/{approval}")).json()
    assert a["status"] == "rejected" and a["comment"] == "Say we're open till 8"
    updated = await until(lambda: [u for u in slack_app.of("chat.update") if u["text"].startswith("Sent back by")])
    assert len(updated) == 2

    # the redraft arrives; Approve from Slack sends it
    redraft = await until(lambda: [b for b in slack_app.of("chat.postMessage") if "open till 8" in json.dumps(b)
                                   and b["channel"] == "U0OWNER"])
    value2 = redraft[-1]["blocks"][1]["elements"][0]["value"]
    await interact(client, action("U0OWNER", "kv_yes", value2))
    a = (await mayank.get(f"/ventures/{v}/approvals/{value2.split(':')[1]}")).json()
    assert a["status"] in ("approved", "executed") and a["decided_by_email"] == mayank.email
    assert tg.to(CUSTOMER2)[-1]["text"] == "Facial is ₹900; we're open till 8 pm."
