"""Telegram Bot API: a business's bot answers its customers.

The owner makes a bot with @BotFather and pastes its token in Settings → Connectors. Kritvia checks
the token (getMe), points the bot's webhook at /hooks/telegram/<connector id> with a random secret
Telegram sends back on every update, and stores the token encrypted. Only private chats are taken;
the bot ignores groups and channels.

The token is part of every Bot API address, so it never appears in an error message or a log line
written here.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import httpx
from sqlalchemy import text

if TYPE_CHECKING:
    from kritvia_api.engine.context import RunContext

API = "https://api.telegram.org"
SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token"
MEDIA = {"photo": "[photo]", "document": "[file]", "voice": "[voice message]", "audio": "[audio]",
         "video": "[video]", "video_note": "[video message]", "sticker": "[sticker]", "location": "[location]",
         "contact": "[contact]", "animation": "[GIF]", "poll": "[poll]"}


class TelegramError(Exception):
    def __init__(self, message: str, *, blocked: bool = False) -> None:
        super().__init__(message)
        self.blocked = blocked


@dataclass
class TelegramConn:
    id: uuid.UUID
    bot_id: str
    username: str | None
    token: str


@dataclass
class TelegramMessage:
    update_id: int
    chat_id: str              # digits; a private chat's id is the customer's user id
    message_id: int
    name: str | None
    handle: str | None
    text: str
    kind: str

    @property
    def provider_id(self) -> str:
        """Unique per bot: Telegram numbers messages within each chat."""
        return f"tg:{self.chat_id}:{self.message_id}"

    @property
    def is_start(self) -> bool:
        words = self.text.strip().split()
        return bool(words) and words[0].split("@", 1)[0].lower() == "/start"


def _friendly(code: Any, description: str) -> TelegramError:
    d = (description or "").lower()
    if code == 401 or "unauthorized" in d:
        return TelegramError("Telegram didn't accept this bot token; copy it again from @BotFather")
    if code == 403 and ("blocked" in d or "deactivated" in d):
        return TelegramError("the customer blocked the bot, so Telegram won't deliver messages to them", blocked=True)
    if code == 403 and "can't initiate" in d:
        return TelegramError("a Telegram bot can only answer people who wrote to it first")
    if code == 400 and "chat not found" in d:
        return TelegramError("Telegram doesn't know this chat (the customer may have deleted it)")
    if code == 429:
        return TelegramError("Telegram asked Kritvia to slow down; try again in a minute")
    if "https" in d and "webhook" in d:
        return TelegramError("Telegram needs the server's public address to be HTTPS")
    return TelegramError(f"Telegram refused it: {(description or str(code))[:200]}")


class TelegramClient:
    def __init__(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._http = httpx.AsyncClient(transport=transport, timeout=30)

    async def _call(self, token: str, method: str, payload: dict[str, Any] | None = None) -> Any:
        if not token or "/" in token:
            raise TelegramError("Telegram didn't accept this bot token; copy it again from @BotFather")
        try:
            r = await self._http.post(f"{API}/bot{token}/{method}", json=payload or {})
        except httpx.HTTPError:
            # the exception's text would carry the address, and with it the token
            raise TelegramError("couldn't reach Telegram; try again in a minute") from None
        try:
            data = r.json()
        except ValueError:
            raise TelegramError(f"Telegram answered with an error ({r.status_code})") from None
        if not isinstance(data, dict) or not data.get("ok"):
            data = data if isinstance(data, dict) else {}
            raise _friendly(data.get("error_code", r.status_code), str(data.get("description") or ""))
        return data.get("result")

    async def get_me(self, token: str) -> dict[str, Any]:
        me = await self._call(token, "getMe")
        if not isinstance(me, dict) or not me.get("is_bot"):
            raise TelegramError("that token isn't a bot's; create the bot with @BotFather")
        return me

    async def set_webhook(self, token: str, url: str, secret: str) -> None:
        await self._call(token, "setWebhook", {"url": url, "secret_token": secret, "allowed_updates": ["message"],
                                               "max_connections": 20})

    async def delete_webhook(self, token: str) -> None:
        await self._call(token, "deleteWebhook", {"drop_pending_updates": False})

    async def send_message(self, conn: TelegramConn, *, chat_id: str, body: str) -> str:
        """Returns the provider message id (as stored with the chat: tg:<chat>:<message>)."""
        chat = "".join(ch for ch in str(chat_id) if ch.isdigit())
        if not chat:
            raise TelegramError("the Telegram chat is missing")
        res = await self._call(conn.token, "sendMessage", {"chat_id": int(chat), "text": body[:4096],
                                                           "link_preview_options": {"is_disabled": True}})
        mid = (res or {}).get("message_id") if isinstance(res, dict) else None
        return f"tg:{chat}:{mid}" if mid is not None else ""


def parse_update(payload: Any) -> TelegramMessage | None:
    """A customer's message to the bot in a private chat, or None for anything else."""
    if not isinstance(payload, dict):
        return None
    m = payload.get("message")
    if not isinstance(m, dict):
        return None
    chat, frm = m.get("chat") or {}, m.get("from") or {}
    if not isinstance(chat, dict) or not isinstance(frm, dict) or chat.get("type") != "private" or frm.get("is_bot"):
        return None
    chat_id = str(chat.get("id") or "")
    if not chat_id.isdigit() or not isinstance(m.get("message_id"), int):
        return None
    if isinstance(m.get("text"), str):
        kind, body = "text", m["text"]
    else:
        kind = next((k for k in MEDIA if k in m), "other")
        caption = m.get("caption") if isinstance(m.get("caption"), str) else ""
        body = f"{MEDIA.get(kind, '[message]')} {caption}".strip()
    name = " ".join(str(frm.get(k) or "").strip() for k in ("first_name", "last_name")).strip() or None
    handle = frm.get("username") if isinstance(frm.get("username"), str) else None
    if handle and not handle.replace("_", "").isalnum():
        handle = None
    return TelegramMessage(int(payload.get("update_id") or 0), chat_id, m["message_id"], name and name[:120],
                           handle and handle[:64], body[:20000], kind)


async def load_telegram(ctx: RunContext, conn) -> TelegramConn | None:
    row = (await conn.execute(
        text("SELECT c.id, c.external_id, c.account_email, t.secret_enc FROM connectors c"
             " JOIN connector_tokens t ON t.connector_id = c.id"
             " WHERE c.venture_id = :v AND c.provider = 'telegram' AND c.status = 'active'"),
        {"v": ctx.venture_id})).first()
    if row is None:
        return None
    token = await ctx.crypto(conn).decrypt_str(ctx.venture_id, "connector.secret", row.secret_enc)
    return TelegramConn(row.id, row.external_id or "", row.account_email, token or "")
