"""Telegram front door: the business's bot is connected with its token, customers' messages arrive with
the webhook secret, are kept per chat, get replies drafted with the chat in mind (sent after a yes),
and the team answers them on the Chats page next to WhatsApp."""
from __future__ import annotations

import json
import uuid

import httpx
import pytest

from conftest import join, make_actor
from test_whatsapp_front_door import approve_latest, script

pytestmark = pytest.mark.asyncio

TOKEN = "7012345678:AAH" + "x" * 32
BOT_ID = 7012345678
CHAT = "551234987"


class FakeTelegram:
    """Bot API stand-in for one bot."""
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.sent: list[dict] = []
        self.webhook: dict | None = None
        self.blocked: set[int] = set()
        self.next_id = 100

    def __call__(self, request: httpx.Request) -> httpx.Response:
        token, method = request.url.path.removeprefix("/bot").split("/", 1)
        body = json.loads(request.content or b"{}")
        self.calls.append((method, body))
        if token != TOKEN:
            return httpx.Response(401, json={"ok": False, "error_code": 401, "description": "Unauthorized"})
        if method == "getMe":
            return httpx.Response(200, json={"ok": True, "result": {"id": BOT_ID, "is_bot": True,
                                                                    "first_name": "Clean Co", "username": "CleanCoBot"}})
        if method == "setWebhook":
            if not body["url"].startswith("https://"):
                return httpx.Response(400, json={"ok": False, "error_code": 400,
                                                 "description": "Bad Request: bad webhook: An HTTPS URL must be provided for webhook"})
            self.webhook = body
            return httpx.Response(200, json={"ok": True, "result": True})
        if method == "deleteWebhook":
            self.webhook = None
            return httpx.Response(200, json={"ok": True, "result": True})
        if method == "sendMessage":
            if body["chat_id"] in self.blocked:
                return httpx.Response(403, json={"ok": False, "error_code": 403,
                                                 "description": "Forbidden: bot was blocked by the user"})
            self.sent.append(body)
            self.next_id += 1
            return httpx.Response(200, json={"ok": True, "result": {"message_id": self.next_id}})
        return httpx.Response(404, json={"ok": False, "error_code": 404, "description": "Not Found"})


@pytest.fixture
def tg(services, monkeypatch):
    from kritvia_api.config import get_settings
    from kritvia_api.services.telegram import TelegramClient
    monkeypatch.setattr(get_settings(), "public_api_url", "https://api.example.test")
    fake = FakeTelegram()
    client = TelegramClient(transport=httpx.MockTransport(fake))
    old = services.telegram, services.messaging.telegram
    services.telegram = services.messaging.telegram = client
    yield fake
    services.telegram, services.messaging.telegram = old


@pytest.fixture(scope="module")
async def shop(world, client):
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Clean Co TG", "slug": f"cleantg-{uuid.uuid4().hex[:6]}"})).json()["id"]
    await mayank.put(f"/ventures/{v}/settings", json={"kind": "general", "business_name": "Clean Co", "city": "Delhi"})
    assert (await mayank.put(f"/ventures/{v}/workflow-configs/inbox_assistant",
                             json={"enabled": True, "settings": {}, "instructions": ""})).status_code == 200
    approver = await make_actor(client, "tg-approver")
    await join(mayank, approver, world["org"], v, "approver")
    operator = await make_actor(client, "tg-operator")
    await join(mayank, operator, world["org"], v, "operator")
    return {**world, "v": v, "approver": approver, "operator": operator}


def update(mid: int, text: str | None, *, chat: str = CHAT, kind: str = "private", first: str = "Neha",
           username: str | None = "neha_k", extra: dict | None = None) -> dict:
    m: dict = {"message_id": mid, "date": 1700000000, "chat": {"id": int(chat), "type": kind},
               "from": {"id": int(chat), "is_bot": False, "first_name": first,
                        **({"username": username} if username else {})}}
    if text is not None:
        m["text"] = text
    m.update(extra or {})
    return {"update_id": 900000 + mid, "message": m}


async def send(client, connector_id: str, secret: str | None, payload: dict) -> httpx.Response:
    headers = {"X-Telegram-Bot-Api-Secret-Token": secret} if secret else {}
    return await client.post(f"/hooks/telegram/{connector_id}", content=json.dumps(payload),
                             headers={**headers, "content-type": "application/json"})


async def tg_runs(actor, v) -> list[dict]:
    return [x for x in (await actor.get(f"/ventures/{v}/runs", params={"workflow": "inbox_assistant"})).json()
            if x["trigger_kind"] == "telegram"]


async def test_bot_is_connected_and_chats_are_answered(shop, client, fake_llm, tg):
    mayank, approver, operator, v = shop["mayank"], shop["approver"], shop["operator"], shop["v"]
    # only admins connect; a wrong token is refused by Telegram and nothing is stored
    assert (await operator.post(f"/ventures/{v}/connectors/telegram", json={"token": TOKEN})).status_code == 404
    bad = await mayank.post(f"/ventures/{v}/connectors/telegram", json={"token": "7012345678:AAH" + "y" * 32})
    assert bad.status_code == 422 and "BotFather" in bad.json()["detail"]
    assert not [c for c in (await mayank.get(f"/ventures/{v}/connectors")).json() if c["provider"] == "telegram"]
    r = await mayank.post(f"/ventures/{v}/connectors/telegram", json={"token": TOKEN})
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["username"] == "CleanCoBot" and out["link"] == "https://t.me/CleanCoBot"
    assert "token" not in json.dumps(out).lower() or TOKEN not in json.dumps(out)
    cid = out["connector_id"]
    assert tg.webhook["url"] == f"https://api.example.test/hooks/telegram/{cid}"
    assert tg.webhook["allowed_updates"] == ["message", "callback_query"]
    secret = tg.webhook["secret_token"]
    conns = (await mayank.get(f"/ventures/{v}/connectors")).json()
    assert [c["account_email"] for c in conns if c["provider"] == "telegram"] == ["@CleanCoBot"]

    # without the secret, or with a wrong one, nothing is read
    assert (await send(client, cid, None, update(1, "Hi"))).status_code == 401
    assert (await send(client, cid, "nope", update(1, "Hi"))).status_code == 401
    # groups are ignored
    assert (await send(client, cid, secret, update(2, "hello all", kind="group"))).json() == {"accepted": 0, "ignored": 1}

    script(fake_llm, reply="Hello Neha! We do kitchen deep cleaning from ₹2,000.")
    r = await send(client, cid, secret, update(3, "/start"))
    assert r.json() == {"accepted": 1, "ignored": 0}, r.text
    run1 = (await tg_runs(mayank, v))[0]
    assert run1["status"] == "waiting"
    assert run1["summary"].get("lead_id")
    lead = next(x for x in (await mayank.get(f"/ventures/{v}/leads")).json() if x["id"] == run1["summary"]["lead_id"])
    assert lead["source"] == "telegram" and lead["name"] == "Neha"
    pending = [a for a in (await approver.get(f"/ventures/{v}/approvals")).json() if a["action"] == "telegram.send"]
    assert len(pending) == 1 and pending[0]["payload"]["to"] == CHAT
    # the recipient can't be swapped while approving
    r = await approver.post(f"/ventures/{v}/approvals/{pending[0]['id']}/decision",
                            json={"decision": "approve", "edited_payload": {"to": "999"}})
    assert r.status_code == 422 and "Telegram" in r.json()["detail"]
    await approve_latest(approver, v, run1["id"])
    assert tg.sent[-1]["chat_id"] == int(CHAT) and "₹2,000" in tg.sent[-1]["text"]
    # a redelivered update is stored once
    assert (await send(client, cid, secret, update(3, "/start"))).json() == {"accepted": 0, "ignored": 1}

    # the next draft sees the chat so far
    script(fake_llm, reply="Sunday works too.")
    await send(client, cid, secret, update(5, "Sunday ko aa sakte ho?"))
    drafts = fake_llm.chat_calls("You answer the business's")
    assert "The chat so far" in drafts[-1]["prompt"] and "₹2,000" in drafts[-1]["prompt"]
    assert "This is a Telegram chat" in drafts[-1]["prompt"]

    chats = (await mayank.get(f"/ventures/{v}/whatsapp/chats")).json()
    assert chats["connected"] is False and chats["telegram_bot"] == "CleanCoBot"
    chat = next(c for c in chats["chats"] if c["channel"] == "telegram")
    assert chat["phone"] == CHAT and chat["handle"] == "neha_k" and chat["name"] == "Neha"
    assert chat["window_open"] is True and chat["opted_in"] is True and chat["pending_approval_id"]
    detail = (await mayank.get(f"/ventures/{v}/whatsapp/chats/{chat['id']}")).json()
    assert [(m["sent_by"], m["kind"]) for m in detail["messages"]] == \
        [("customer", "start"), ("kritvia", "text"), ("customer", "text")]
    assert detail["messages"][0]["body"] == "/start"

    # templates are WhatsApp's
    r = await mayank.post(f"/ventures/{v}/whatsapp/chats/{chat['id']}/template",
                          json={"template_id": str(uuid.uuid4()), "params": []})
    assert r.status_code == 409 and "WhatsApp" in r.json()["detail"]

    # the team answers: sent from the bot, the chat is theirs, Kritvia's waiting draft is withdrawn
    assert (await approver.post(f"/ventures/{v}/whatsapp/chats/{chat['id']}/reply", json={"body": "x"})).status_code == 403
    r = await operator.post(f"/ventures/{v}/whatsapp/chats/{chat['id']}/reply", json={"body": "Haan, Sunday 11 baje."})
    assert r.status_code == 201, r.text
    assert r.json()["sent_by"] == "person" and tg.sent[-1]["text"] == "Haan, Sunday 11 baje."
    after = (await mayank.get(f"/ventures/{v}/whatsapp/chats/{chat['id']}")).json()["chat"]
    assert after["handled_by"] == "person" and after["pending_approval_id"] is None
    assert sorted(x["status"] for x in await tg_runs(mayank, v)) == ["cancelled", "completed"]

    # while a person handles it, new messages are kept and nothing is drafted
    before = len(await tg_runs(mayank, v))
    assert (await send(client, cid, secret, update(7, "Thanks!"))).json() == {"accepted": 1, "ignored": 0}
    assert len(await tg_runs(mayank, v)) == before

    # a customer who blocked the bot: the reply fails with a clear reason and is marked in the chat
    tg.blocked.add(int(CHAT))
    r = await operator.post(f"/ventures/{v}/whatsapp/chats/{chat['id']}/reply", json={"body": "Still there?"})
    assert r.status_code == 502 and "blocked the bot" in r.json()["detail"]
    tg.blocked.clear()

    # /stop opts out
    assert (await mayank.put(f"/ventures/{v}/whatsapp/chats/{chat['id']}/handler",
                             json={"handled_by": "kritvia"})).status_code == 200
    await send(client, cid, secret, update(9, "/stop"))
    stopped = (await mayank.get(f"/ventures/{v}/whatsapp/chats/{chat['id']}")).json()["chat"]
    assert stopped["opted_out"] is True
    assert (await operator.post(f"/ventures/{v}/whatsapp/chats/{chat['id']}/reply",
                                json={"body": "Hello?"})).status_code == 409


async def test_chats_are_kept_apart_by_app_and_media_is_described(shop, client, services, fake_llm, tg):
    from sqlalchemy import text

    from kritvia_api.db.session import tenant_tx
    from kritvia_api.services import wa_inbox
    from kritvia_api.services.crypto import EnvelopeCrypto
    mayank, v = shop["mayank"], shop["v"]
    r = await mayank.post(f"/ventures/{v}/connectors/telegram", json={"token": TOKEN})
    assert r.status_code == 201, r.text
    cid, secret = r.json()["connector_id"], tg.webhook["secret_token"]
    script(fake_llm, category="support", reply="We'll check the photo.")
    photo = update(20, None, chat="919811122233", first="Ravi", username=None,
                   extra={"photo": [{"file_id": "f"}], "caption": "Stain on the sofa"})
    assert (await send(client, cid, secret, photo)).json()["accepted"] == 1
    # a WhatsApp customer whose number has the same digits is a different chat
    async with tenant_tx(None, "system") as conn:
        p = (await conn.execute(text("SELECT * FROM private.telegram_principal(:c, :h)"),
                                {"c": cid, "h": __import__("hashlib").sha256(secret.encode()).hexdigest()})).first()
    async with tenant_tx(p.run_as, "agent", "whatsapp") as conn:
        await wa_inbox.record_inbound(conn, EnvelopeCrypto(conn, services.keys), org_id=p.org_id,
                                      venture_id=uuid.UUID(v), phone="919811122233", name="Ravi WA", body="Hi",
                                      kind="text", provider_id=f"wamid.{uuid.uuid4().hex}")
    chats = [c for c in (await mayank.get(f"/ventures/{v}/whatsapp/chats")).json()["chats"]
             if c["phone"] == "919811122233"]
    assert sorted(c["channel"] for c in chats) == ["telegram", "whatsapp"]
    tgc = next(c for c in chats if c["channel"] == "telegram")
    assert tgc["last_message"] == "[photo] Stain on the sofa" and tgc["handle"] is None
    wac = next(c for c in chats if c["channel"] == "whatsapp")
    assert wac["window_open"] is True and wac["name"] == "Ravi WA"

    # disconnecting unhooks the bot; its updates are refused afterwards
    assert (await mayank.delete(f"/ventures/{v}/connectors/{cid}")).status_code == 204
    assert tg.webhook is None and tg.calls[-1][0] == "deleteWebhook"
    assert (await send(client, cid, secret, update(21, "Hello?"))).status_code == 401


async def test_connecting_needs_an_https_server_address(shop, tg, monkeypatch):
    from kritvia_api.config import get_settings
    monkeypatch.setattr(get_settings(), "public_api_url", "http://localhost:8000")
    mayank, v = shop["mayank"], shop["v"]
    r = await mayank.post(f"/ventures/{v}/connectors/telegram", json={"token": TOKEN})
    assert r.status_code == 422 and "HTTPS" in r.json()["detail"]


async def test_updates_are_read_safely():
    from kritvia_api.services.telegram import parse_update
    m = parse_update(update(1, "/start@CleanCoBot promo"))
    assert m and m.is_start and m.chat_id == CHAT and m.provider_id == f"tg:{CHAT}:1" and m.handle == "neha_k"
    assert parse_update(update(2, "hi", kind="supergroup")) is None
    assert parse_update({"update_id": 1, "edited_message": update(3, "x")["message"]}) is None
    bot = update(4, "hi")
    bot["message"]["from"]["is_bot"] = True
    assert parse_update(bot) is None
    assert parse_update(update(5, None, extra={"voice": {}})).text == "[voice message]"
    assert parse_update("nope") is None and parse_update({"message": {"chat": "x"}}) is None
