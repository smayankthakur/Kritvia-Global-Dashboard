"""Approve from your phone: drafts waiting for a yes reach team members in Telegram and Slack.

A team member links their own Telegram chat (through the business's bot) or Slack account (through
Kritvia's Slack app) on the Account page. From then on every draft they could decide in the app also
arrives there as a card with Approve, Reject and Ask for changes. A press decides AS that person, with
the same role checks as the app (decide_approval), so a link never gives anyone more rights.

* Sensitive drafts arrive without buttons: they are reviewed in the app.
* "Ask for changes" rejects with the person's words, which makes the agent redraft.
* Once a draft is decided anywhere (app, Telegram or Slack) its cards are updated to say so.

Everything here is best effort: a chat problem never touches a run or a decision.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import secrets
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import text

from kritvia_api.config import get_settings
from kritvia_api.db.session import tenant_tx

log = logging.getLogger(__name__)
_background: set[asyncio.Task] = set()
LINK_PREFIX = "link_"
CHANGES_PROMPT = "What should change? Write it in one message and the draft goes back to be redone."
STATUS_WORD = {"approved": "Approved", "edited": "Approved with edits", "rejected": "Sent back",
               "expired": "Expired", "cancelled": "Withdrawn", "executed": "Approved", "auto_approved": "Approved"}


def new_code() -> str:
    """32 characters from Telegram's deep-link alphabet (A-Z a-z 0-9 _ -)."""
    return secrets.token_urlsafe(24)


def code_hash(code: str) -> str:
    return hashlib.sha256(("approver-link|" + code).encode()).hexdigest()


def _later(coro) -> None:
    try:
        task = asyncio.get_running_loop().create_task(coro)
    except RuntimeError:          # no running loop (scripts)
        coro.close()
        return
    _background.add(task)
    task.add_done_callback(_background.discard)


def _link(path: str) -> str:
    return get_settings().public_web_url.rstrip("/") + path


def preview(payload: dict[str, Any]) -> str:
    """The part of a draft a person needs to say yes: who it goes to and what it says."""
    lines: list[str] = []
    for key, label in (("to", "To"), ("subject", "Subject")):
        v = payload.get(key)
        if isinstance(v, str | int) and str(v).strip():
            lines.append(f"{label}: {str(v).strip()[:120]}")
    for key in ("body", "text", "message", "reply", "content", "description"):
        v = payload.get(key)
        if isinstance(v, str) and v.strip():
            body = v.strip()
            lines.append(body[:700] + ("…" if len(body) > 700 else ""))
            break
    return "\n".join(lines)


def card_text(title: str, summary: str, payload: dict[str, Any], business: str | None, sensitive: bool) -> str:
    head = "A draft needs your yes" + (f" · {business}" if business else "")
    parts = [head, "", title.strip()[:300]]
    if summary.strip():
        parts.append(summary.strip()[:400])
    if sensitive:
        parts += ["", "This one is marked sensitive, so it is reviewed in Kritvia."]
    else:
        shown = preview(payload)
        if shown:
            parts += ["", shown]
        b = payload.get("booking")
        if isinstance(b, dict) and b.get("service"):
            parts += ["", f"Approving also books: {b.get('service')}, {b.get('when') or b.get('starts_at')}"]
    return "\n".join(parts)[:4000]


# ------------------------------------------------------------------- sending --
def announce(venture_id: uuid.UUID, approval_id: uuid.UUID, *, title: str, summary: str,
             payload: dict[str, Any], sensitive: bool) -> None:
    """Called by the runner when a draft starts waiting; sends the cards in the background."""
    _later(_announce(venture_id, approval_id, title, summary, payload, sensitive))


async def _announce(venture_id, approval_id, title, summary, payload, sensitive) -> None:
    for send in (_telegram_cards, _slack_cards, _whatsapp_cards):
        try:
            await send(venture_id, approval_id, title, summary, payload, sensitive)
        except Exception:  # noqa: BLE001 - a card is a courtesy
            log.exception("%s failed for approval %s", send.__name__, approval_id)


async def _targets(approval_id: uuid.UUID, channel: str):
    async with tenant_tx(None, "system") as conn:
        return (await conn.execute(text("SELECT * FROM private.approval_chat_targets(:a, :c)"),
                                   {"a": approval_id, "c": channel})).all()


async def _keep_notes(run_as: uuid.UUID, channel: str, org_id, venture_id, approval_id, notes) -> None:
    if not notes:
        return
    async with tenant_tx(run_as, "agent", channel) as conn:
        for chat, mid in notes:
            await conn.execute(text(
                "INSERT INTO approval_notes (org_id, venture_id, approval_id, channel, chat, message_id)"
                " VALUES (:o, :v, :a, :ch, :c, :m)"),
                {"o": org_id, "v": venture_id, "a": approval_id, "ch": channel, "c": chat, "m": mid})


@dataclass
class _Bot:
    run_as: uuid.UUID
    org_id: uuid.UUID
    token: str
    business: str | None


async def telegram_bot(venture_id: uuid.UUID) -> _Bot | None:
    """The business's bot (read as its runtime), if connected and allowed by its plan."""
    from kritvia_api.engine.context import get_services
    from kritvia_api.services.crypto import EnvelopeCrypto
    from kritvia_api.services.quota import plan_for_venture
    async with tenant_tx(None, "system") as conn:
        b = (await conn.execute(text("SELECT * FROM private.telegram_bot_for(:v)"), {"v": venture_id})).first()
    if b is None:
        return None
    async with tenant_tx(b.run_as, "agent", "telegram") as conn:
        if not (await plan_for_venture(conn, venture_id)).allows_integration("telegram"):
            return None
        row = (await conn.execute(text(
            "SELECT t.secret_enc, v.name FROM connector_tokens t JOIN ventures v ON v.id = t.venture_id"
            " WHERE t.connector_id = :c"), {"c": b.connector_id})).first()
        if row is None:
            return None
        token = await EnvelopeCrypto(conn, get_services().keys).decrypt_str(venture_id, "connector.secret",
                                                                            row.secret_enc)
    return _Bot(b.run_as, b.org_id, token or "", row.name) if token else None


async def ensure_buttons(venture_id: uuid.UUID, svc) -> None:
    """Bots connected before approvals in chat were only sent messages: point them at button presses too
    (with a fresh webhook secret). Raises TelegramError if Telegram refuses."""
    import json
    async with tenant_tx(None, "system") as conn:
        b = (await conn.execute(text("SELECT * FROM private.telegram_bot_for(:v)"), {"v": venture_id})).first()
    if b is None:
        return
    async with tenant_tx(b.run_as, "agent", "telegram") as conn:
        if (await conn.execute(text("SELECT meta ->> 'buttons' FROM connectors WHERE id = :c"),
                               {"c": b.connector_id})).scalar() == "true":
            return
    bot = await telegram_bot(venture_id)
    if bot is None:
        return
    secret = secrets.token_urlsafe(32)
    async with tenant_tx(b.run_as, "agent", "telegram") as conn:
        await conn.execute(text("UPDATE connectors SET meta = meta || CAST(:m AS jsonb), updated_at = now() WHERE id = :c"),
                           {"c": b.connector_id, "m": json.dumps({"secret_hash": hashlib.sha256(secret.encode()).hexdigest(),
                                                                 "buttons": True})})
        # inside the transaction: if Telegram refuses, the old secret stays
        await svc.telegram.set_webhook(bot.token, f"{get_settings().public_api_url}/hooks/telegram/{b.connector_id}",
                                       secret)


def telegram_keyboard(approval_id: uuid.UUID, venture_id: uuid.UUID, sensitive: bool) -> dict:
    rows: list[list[dict]] = []
    if not sensitive:
        rows += [[{"text": "Approve", "callback_data": f"a:{approval_id}:y"},
                  {"text": "Reject", "callback_data": f"a:{approval_id}:n"}],
                 [{"text": "Ask for changes", "callback_data": f"a:{approval_id}:c"}]]
    url = _link(f"/inbox?id={approval_id}")
    if url.startswith("https://"):            # Telegram refuses plain-http buttons
        rows.append([{"text": "Open in Kritvia", "url": url}])
    return {"inline_keyboard": rows}


async def _telegram_cards(venture_id, approval_id, title, summary, payload, sensitive) -> None:
    from kritvia_api.engine.context import get_services
    from kritvia_api.services.telegram import TelegramError
    targets = await _targets(approval_id, "telegram")
    if not targets:
        return
    bot = await telegram_bot(venture_id)
    if bot is None:
        return
    tg = get_services().telegram
    body = card_text(title, summary, payload, bot.business, sensitive)
    notes = []
    for t in targets:
        try:
            res = await tg.call(bot.token, "sendMessage", {
                "chat_id": int(t.external_id), "text": body, "link_preview_options": {"is_disabled": True},
                "reply_markup": telegram_keyboard(approval_id, venture_id, sensitive)})
        except (TelegramError, ValueError):
            continue
        if isinstance(res, dict) and res.get("message_id") is not None:
            notes.append((t.external_id, str(res["message_id"])))
    await _keep_notes(bot.run_as, "telegram", bot.org_id, venture_id, approval_id, notes)


async def card_for(run_as: uuid.UUID, venture_id: uuid.UUID, approval_id: uuid.UUID) -> dict[str, Any] | None:
    """A pending draft's card content, read again (for /waiting), as the business's runtime."""
    import json

    from kritvia_api.engine.context import get_services
    from kritvia_api.engine.runner import PAYLOAD_PURPOSE
    from kritvia_api.services.crypto import EnvelopeCrypto
    async with tenant_tx(run_as, "agent", "chat") as conn:
        a = (await conn.execute(text("SELECT title, summary, payload_enc, sensitive, status FROM approvals"
                                     " WHERE id = :a AND venture_id = :v"), {"a": approval_id, "v": venture_id})).first()
        if a is None or a.status != "pending":
            return None
        raw = await EnvelopeCrypto(conn, get_services().keys).decrypt_str(venture_id, PAYLOAD_PURPOSE, a.payload_enc)
    try:
        payload = json.loads(raw or "{}")
    except ValueError:
        payload = {}
    return {"title": a.title, "summary": a.summary, "payload": payload if isinstance(payload, dict) else {},
            "sensitive": a.sensitive}


async def telegram_card_to(venture_id: uuid.UUID, approval_id: uuid.UUID, chat: str) -> None:
    """One pending draft's card, to one linked chat (/waiting)."""
    from kritvia_api.engine.context import get_services
    from kritvia_api.services.telegram import TelegramError
    bot = await telegram_bot(venture_id)
    card = await card_for(bot.run_as, venture_id, approval_id) if bot else None
    if card is None or bot is None:
        return
    try:
        res = await get_services().telegram.call(bot.token, "sendMessage", {
            "chat_id": int(chat), "text": card_text(card["title"], card["summary"], card["payload"], bot.business,
                                                    card["sensitive"]),
            "link_preview_options": {"is_disabled": True},
            "reply_markup": telegram_keyboard(approval_id, venture_id, card["sensitive"])})
    except (TelegramError, ValueError):
        return
    if isinstance(res, dict) and res.get("message_id") is not None:
        await _keep_notes(bot.run_as, "telegram", bot.org_id, venture_id, approval_id, [(chat, str(res["message_id"]))])


# ------------------------------------------------------------------ WhatsApp --
def whatsapp_buttons(approval_id: uuid.UUID, sensitive: bool) -> list[tuple[str, str]]:
    """Reply buttons (WhatsApp allows 3, titles up to 20 characters)."""
    if sensitive:
        return []
    return [(f"a:{approval_id}:y", "Approve"), (f"a:{approval_id}:n", "Reject"), (f"a:{approval_id}:c", "Ask for changes")]


def _whatsapp_card(card: dict[str, Any], business: str | None, approval_id: uuid.UUID) -> str:
    body = card_text(card["title"], card["summary"], card["payload"], business, card["sensitive"])
    if card["sensitive"]:
        body += "\n\nOpen it in Kritvia: " + _link(f"/inbox?id={approval_id}")
    return body[:1000]           # WhatsApp's limit for a message with buttons


async def whatsapp_card_to(venture_id: uuid.UUID, approval_id: uuid.UUID, user_id: uuid.UUID, chat: str,
                           card: dict[str, Any] | None = None) -> None:
    from kritvia_api.services import front_door
    n = await front_door.whatsapp_number(venture_id)
    if n is None:
        return
    card = card or await card_for(n.run_as, venture_id, approval_id)
    if card is None:
        return
    mid = await front_door.whatsapp_say(venture_id, user_id, chat, _whatsapp_card(card, n.business, approval_id),
                                        whatsapp_buttons(approval_id, card["sensitive"]))
    if mid:
        await _keep_notes(n.run_as, "whatsapp", n.org_id, venture_id, approval_id, [(chat, mid[:64])])


async def _whatsapp_cards(venture_id, approval_id, title, summary, payload, sensitive) -> None:
    targets = await _targets(approval_id, "whatsapp")
    if not targets:
        return
    card = {"title": title, "summary": summary, "payload": payload, "sensitive": sensitive}
    for t in targets:
        await whatsapp_card_to(venture_id, approval_id, t.user_id, t.external_id, card)


def slack_blocks(text_: str, approval_id: uuid.UUID, venture_id: uuid.UUID, sensitive: bool) -> list[dict]:
    from kritvia_api.services.slack import _escape
    value = f"{venture_id}:{approval_id}"
    buttons: list[dict] = []
    if not sensitive:
        buttons += [{"type": "button", "action_id": "kv_yes", "style": "primary", "value": value,
                     "text": {"type": "plain_text", "text": "Approve"}},
                    {"type": "button", "action_id": "kv_no", "style": "danger", "value": value,
                     "text": {"type": "plain_text", "text": "Reject"}},
                    {"type": "button", "action_id": "kv_change", "value": value,
                     "text": {"type": "plain_text", "text": "Ask for changes"}}]
    buttons.append({"type": "button", "action_id": "kv_open", "url": _link(f"/inbox?id={approval_id}"),
                    "text": {"type": "plain_text", "text": "Open in Kritvia"}})
    return [{"type": "section", "text": {"type": "mrkdwn", "text": _escape(text_)[:2900]}},
            {"type": "actions", "elements": buttons}]


async def _slack_cards(venture_id, approval_id, title, summary, payload, sensitive) -> None:
    from kritvia_api.engine.context import get_services
    from kritvia_api.services import slack
    if not slack.app_configured():
        return
    targets = await _targets(approval_id, "slack")
    if not targets:
        return
    app = await slack.app_token(venture_id)
    if app is None:
        return
    p, bot, team = app
    async with tenant_tx(p.run_as, "agent", "slack") as conn:
        business = (await conn.execute(text("SELECT name FROM ventures WHERE id = :v"), {"v": venture_id})).scalar()
    client = get_services().slack
    body = card_text(title, summary, payload, business, sensitive)
    notes = []
    for t in targets:
        if t.external_team and t.external_team != team:
            continue
        try:
            res = await client.api(bot, "chat.postMessage", {
                "channel": t.external_id, "text": f"A draft needs your yes: {title[:120]}",
                "blocks": slack_blocks(body, approval_id, venture_id, sensitive),
                "unfurl_links": False, "unfurl_media": False})
        except slack.SlackError:
            continue
        if res.get("channel") and res.get("ts"):
            notes.append((str(res["channel"])[:64], str(res["ts"])[:64]))
    await _keep_notes(p.run_as, "slack", p.org_id, venture_id, approval_id, notes)


# ------------------------------------------------------------------ deciding --
async def approver(venture_id: uuid.UUID, channel: str, external: str):
    async with tenant_tx(None, "system") as conn:
        return (await conn.execute(text("SELECT * FROM private.approver_for(:v, :c, :x)"),
                                   {"v": venture_id, "c": channel, "x": external})).first()


async def decide_as(user_id: uuid.UUID, venture_id: uuid.UUID, approval_id: uuid.UUID, decision: str,
                    comment: str | None, svc) -> tuple[bool, str]:
    """Decides as the linked person, through the same code path as the app. Returns (ok, short text)."""
    from fastapi import HTTPException

    from kritvia_api.routers.approvals import DecisionIn, decide
    try:
        await decide(venture_id, approval_id, DecisionIn(decision=decision, comment=comment), user_id, svc)
    except HTTPException as exc:
        detail = str(exc.detail).lower()
        if exc.status_code == 409 or "already" in detail or "expired" in detail:
            await settle(venture_id, approval_id)
            return False, "This draft was already decided."
        if exc.status_code in (403, 404) or "not permitted" in detail:
            return False, "You can't decide this one; open Kritvia to see who can."
        return False, "Couldn't save that; try again in Kritvia."
    return True, "Approved" if decision == "approve" else "Sent back"


async def set_pending_changes(run_as: uuid.UUID, channel: str, link_id: uuid.UUID,
                              approval_id: uuid.UUID | None) -> None:
    async with tenant_tx(run_as, "agent", channel) as conn:
        await conn.execute(text("UPDATE approver_links SET pending_changes = :a WHERE id = :l"),
                           {"a": approval_id, "l": link_id})


def settle_later(venture_id: uuid.UUID, approval_id: uuid.UUID, who: str | None = None) -> None:
    _later(settle(venture_id, approval_id, who))


async def settle(venture_id: uuid.UUID, approval_id: uuid.UUID, who: str | None = None) -> None:
    """Once a draft is decided, its cards say so and lose their buttons."""
    try:
        await _settle(venture_id, approval_id, who)
    except Exception:  # noqa: BLE001
        log.exception("updating chat cards failed for approval %s", approval_id)


async def _settle(venture_id: uuid.UUID, approval_id: uuid.UUID, who: str | None) -> None:
    from kritvia_api.engine.context import get_services
    from kritvia_api.services import slack
    from kritvia_api.services.telegram import TelegramError
    async with tenant_tx(None, "system") as conn:
        b = (await conn.execute(text("SELECT * FROM private.telegram_bot_for(:v)"), {"v": venture_id})).first() \
            or (await conn.execute(text("SELECT * FROM private.slack_principal(:v)"), {"v": venture_id})).first() \
            or (await conn.execute(text("SELECT * FROM private.whatsapp_number_for(:v)"), {"v": venture_id})).first()
    if b is None:
        return
    async with tenant_tx(b.run_as, "agent", "telegram") as conn:
        a = (await conn.execute(text("SELECT title, status FROM approvals WHERE id = :a AND venture_id = :v"),
                                {"a": approval_id, "v": venture_id})).first()
        notes = (await conn.execute(text("SELECT id, channel, chat, message_id FROM approval_notes"
                                         " WHERE approval_id = :a"), {"a": approval_id})).all()
    if a is None or a.status == "pending" or not notes:
        return
    word = STATUS_WORD.get(a.status, a.status.capitalize())
    line = f"{word}{' by ' + who if who else ''}: {a.title[:200]}"
    svc = get_services()
    done: list[uuid.UUID] = []
    tg = [n for n in notes if n.channel == "telegram"]
    if tg:
        bot = await telegram_bot(venture_id)
        for n in tg:
            if bot is not None:
                try:
                    await svc.telegram.call(bot.token, "editMessageText", {
                        "chat_id": int(n.chat), "message_id": int(n.message_id), "text": line,
                        "reply_markup": {"inline_keyboard": []}})
                except (TelegramError, ValueError):
                    pass
            done.append(n.id)
    sl = [n for n in notes if n.channel == "slack"]
    if sl:
        app = await slack.app_token(venture_id) if slack.app_configured() else None
        for n in sl:
            if app is not None:
                try:
                    await svc.slack.api(app[1], "chat.update", {
                        "channel": n.chat, "ts": n.message_id, "text": line,
                        "blocks": [{"type": "section", "text": {"type": "mrkdwn", "text": slack._escape(line)}}]})
                except slack.SlackError:
                    pass
            done.append(n.id)
    done += [n.id for n in notes if n.channel == "whatsapp"]   # WhatsApp can't edit a sent message
    async with tenant_tx(b.run_as, "agent", "telegram") as conn:
        await conn.execute(text("DELETE FROM approval_notes WHERE id = ANY(:ids)"), {"ids": done})


# ------------------------------------------------------------------ Telegram --
async def telegram_update(p, payload: Any, svc) -> bool:
    """A team member's update to the business's bot: a link code, a button press, or their answer to
    "what should change?". Returns False for everything else (customers), which the caller handles."""
    from kritvia_api.services.telegram import parse_button, parse_update
    button = parse_button(payload)
    if button is not None:
        await _telegram_button(p, button, svc)
        return True
    m = parse_update(payload)
    if m is None:
        return False
    words = m.text.strip().split()
    if m.is_start and len(words) == 2 and words[1].startswith(LINK_PREFIX):
        await _telegram_link(p, m, words[1][len(LINK_PREFIX):], svc)
        return True
    link = await approver(p.venture_id, "telegram", m.chat_id)
    if link is None:
        return False
    bot = await telegram_bot(p.venture_id)
    if bot is None:
        return True
    await touch(p.run_as, link.link_id)
    if link.pending_changes is not None and m.kind == "text" and not m.text.startswith("/"):
        await set_pending_changes(p.run_as, "telegram", link.link_id, None)
        ok, said = await decide_as(link.user_id, p.venture_id, link.pending_changes, "reject",
                                   m.text.strip()[:2000], svc)
        await _tg_say(svc, bot.token, m.chat_id, "Thanks: the draft goes back to be redone with your note." if ok else said)
        return True
    # Anything else is the person talking to the business: the assistant, a report, their drafts.
    from kritvia_api.services import front_door
    if m.kind != "text" and not m.file_id:
        await _tg_say(svc, bot.token, m.chat_id, "I read messages and voice notes here. Type it, or send a voice note.")
        return True

    async def say(body: str) -> None:
        await _tg_say(svc, bot.token, m.chat_id, body)

    async def resend(ids: list[uuid.UUID]) -> None:
        for aid in ids:
            await telegram_card_to(p.venture_id, aid, m.chat_id)

    async def audio() -> tuple[bytes, str] | None:
        from kritvia_api.services.telegram import TelegramError
        try:
            return await svc.telegram.download(bot.token, m.file_id), "voice.ogg"
        except TelegramError:
            return None
    await front_door.handle(svc, front_door.Asker("telegram", p.venture_id, link.user_id, m.chat_id, m.provider_id,
                                                  bot.business),
                            text_=m.text if m.kind == "text" else "", say=say, resend_cards=resend,
                            audio=audio if m.file_id else None)
    return True


async def touch(run_as: uuid.UUID, link_id: uuid.UUID) -> None:
    """The person just wrote from this chat (WhatsApp's 24-hour window starts again)."""
    async with tenant_tx(run_as, "agent", "chat") as conn:
        await conn.execute(text("UPDATE approver_links SET last_inbound_at = now() WHERE id = :l"), {"l": link_id})


async def _tg_say(svc, token: str, chat: str, body: str, markup: dict | None = None) -> None:
    from kritvia_api.services.telegram import TelegramError
    payload: dict[str, Any] = {"chat_id": int(chat), "text": body[:4000]}
    if markup:
        payload["reply_markup"] = markup
    try:
        await svc.telegram.call(token, "sendMessage", payload)
    except TelegramError:
        pass


async def _telegram_link(p, m, code: str, svc) -> None:
    bot = await telegram_bot(p.venture_id)
    if bot is None:
        return
    async with tenant_tx(None, "system") as conn:
        who = (await conn.execute(text("SELECT * FROM private.redeem_approver_link_code(:v, 'telegram', :h, :x, NULL, :l)"),
                                  {"v": p.venture_id, "h": code_hash(code[:64]), "x": m.chat_id,
                                   "l": ("@" + m.handle) if m.handle else (m.name or "Telegram")})).first()
    if who is None:
        await _tg_say(svc, bot.token, m.chat_id, "That link has expired. In Kritvia, open Account → Approve from "
                                                  "your phone and tap Link Telegram again.")
        return
    await _tg_say(svc, bot.token, m.chat_id,
                  f"Linked. Hi {who.full_name or 'there'}: ask me anything about {bot.business} here, by message or "
                  "voice note, and drafts that need your yes arrive here with Approve, Reject and Ask for changes "
                  "buttons. Send /help to see how.")


async def _telegram_button(p, button, svc) -> None:
    from kritvia_api.services.telegram import TelegramError
    bot = await telegram_bot(p.venture_id)
    if bot is None:
        return

    async def answer(msg: str, alert: bool = False) -> None:
        try:
            await svc.telegram.call(bot.token, "answerCallbackQuery",
                                    {"callback_query_id": button.callback_id, "text": msg[:190], "show_alert": alert})
        except TelegramError:
            pass

    parts = button.data.split(":")
    try:
        approval_id = uuid.UUID(parts[1]) if len(parts) == 3 and parts[0] == "a" and parts[2] in "ync" else None
    except ValueError:
        approval_id = None
    if approval_id is None:
        await answer("This button is out of date.")
        return
    link = await approver(p.venture_id, "telegram", button.from_id)
    if link is None:
        await answer("This Telegram account isn't linked to Kritvia. Link it from Account in Kritvia.", True)
        return
    if parts[2] == "c":
        await set_pending_changes(p.run_as, "telegram", link.link_id, approval_id)
        await answer("Tell me what to change")
        await _tg_say(svc, bot.token, button.chat_id, CHANGES_PROMPT, {"force_reply": True})
        return
    ok, said = await decide_as(link.user_id, p.venture_id, approval_id, "approve" if parts[2] == "y" else "reject",
                               None, svc)
    await answer(said, alert=not ok)


# ------------------------------------------------------------- WhatsApp (in) --
async def whatsapp_update(p, m, svc) -> bool:
    """A message to the business's WhatsApp number from a team member: their link code, a button on a
    draft's card, their "what should change" answer, or anything they ask the business. Returns False
    for everyone else (customers), whose messages the caller keeps as chats."""
    from kritvia_api.services import front_door
    words = m.text.strip().split()
    if m.kind == "text" and len(words) == 1 and words[0].startswith(LINK_PREFIX):
        async with tenant_tx(None, "system") as conn:
            who = (await conn.execute(text(
                "SELECT * FROM private.redeem_approver_link_code(:v, 'whatsapp', :h, :x, NULL, :l)"),
                {"v": p.venture_id, "h": code_hash(words[0][len(LINK_PREFIX):][:64]), "x": m.sender,
                 "l": "+" + m.sender})).first()
        if who is None:
            return False          # not a code we gave out: an ordinary customer message
        link = await approver(p.venture_id, "whatsapp", m.sender)
        if link is not None:
            await touch(p.run_as, link.link_id)
        n = await front_door.whatsapp_number(p.venture_id)
        await front_door.whatsapp_say(p.venture_id, None, m.sender,
                                      f"Linked. Hi {who.full_name or 'there'}: ask me anything about "
                                      f"{(n.business if n else None) or 'the business'} here, by message or voice note. "
                                      "Drafts that need your yes arrive here too. Send /help to see how.",
                                      check_window=False)
        return True
    link = await approver(p.venture_id, "whatsapp", m.sender)
    if link is None:
        return False
    await touch(p.run_as, link.link_id)

    async def say(body: str) -> None:
        await front_door.whatsapp_say(p.venture_id, link.user_id, m.sender, body[:4000])

    if m.reply_id and m.reply_id.startswith("a:"):
        parts = m.reply_id.split(":")
        try:
            approval_id = uuid.UUID(parts[1]) if len(parts) == 3 and parts[2] in ("y", "n", "c") else None
        except ValueError:
            approval_id = None
        if approval_id is None:
            await say("That button is out of date.")
        elif parts[2] == "c":
            await set_pending_changes(p.run_as, "whatsapp", link.link_id, approval_id)
            await say(CHANGES_PROMPT)
        else:
            ok, said = await decide_as(link.user_id, p.venture_id, approval_id,
                                       "approve" if parts[2] == "y" else "reject", None, svc)
            await say(said)
        return True
    if link.pending_changes is not None and m.kind == "text" and not m.text.startswith("/"):
        await set_pending_changes(p.run_as, "whatsapp", link.link_id, None)
        ok, said = await decide_as(link.user_id, p.venture_id, link.pending_changes, "reject", m.text.strip()[:2000], svc)
        await say("Thanks: the draft goes back to be redone with your note." if ok else said)
        return True
    if m.kind not in ("text", "audio") or (m.kind == "audio" and not m.media_id):
        await say("I read messages and voice notes here. Type it, or send a voice note.")
        return True
    n = await front_door.whatsapp_number(p.venture_id)

    async def resend(ids: list[uuid.UUID]) -> None:
        for aid in ids:
            await whatsapp_card_to(p.venture_id, aid, link.user_id, m.sender)

    async def audio() -> tuple[bytes, str] | None:
        from kritvia_api.services.whatsapp import WhatsAppError
        if n is None:
            return None
        try:
            data, mime = await svc.whatsapp.media(n.conn, m.media_id)
        except WhatsAppError:
            return None
        return data, "voice." + {"audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/amr": "amr"}.get(
            mime.split(";")[0].strip(), "ogg")
    await front_door.handle(svc, front_door.Asker("whatsapp", p.venture_id, link.user_id, m.sender, m.message_id,
                                                  n.business if n else None),
                            text_=m.text if m.kind == "text" else "", say=say, resend_cards=resend,
                            audio=audio if m.kind == "audio" else None)
    return True


# --------------------------------------------------------------------- Slack --
async def slack_interaction(payload: dict[str, Any], svc) -> dict | None:
    """One signed interaction from Kritvia's Slack app. Returns the response body Slack expects (None:
    an empty 200)."""
    from kritvia_api.services import slack
    team = str(((payload.get("team") or {}).get("id")) or (payload.get("user") or {}).get("team_id") or "")
    user = str((payload.get("user") or {}).get("id") or "")
    if not team or not user:
        return None
    if payload.get("type") == "view_submission":
        view = payload.get("view") or {}
        if view.get("callback_id") != "kv_change":
            return None
        venture_id, approval_id = _ids(view.get("private_metadata"))
        if venture_id is None:
            return None
        note = ""
        for block in ((view.get("state") or {}).get("values") or {}).values():
            v = (block or {}).get("note") or {}
            note = str(v.get("value") or "").strip()
        if not note:
            return {"response_action": "errors", "errors": {"change": "Say what should change"}}
        found = await _slack_person(team, venture_id, user)
        if found is None:
            return {"response_action": "errors", "errors": {"change": "Your Slack account isn't linked to Kritvia"}}
        ok, said = await decide_as(found.user_id, venture_id, approval_id, "reject", note[:2000], svc)
        if not ok:
            return {"response_action": "errors", "errors": {"change": said}}
        return None
    if payload.get("type") != "block_actions":
        return None
    actions = payload.get("actions") or []
    if not actions:
        return None
    action = actions[0]
    aid = action.get("action_id")
    if aid == "kv_link":
        await _slack_link(team, user, str(action.get("value") or ""), payload, svc)
        return None
    if aid not in ("kv_yes", "kv_no", "kv_change"):
        return None
    venture_id, approval_id = _ids(action.get("value"))
    if venture_id is None:
        return None
    app = await slack.app_token(venture_id, team)
    if app is None:
        return None
    found = await _slack_person(team, venture_id, user)
    if found is None:
        await _slack_ephemeral(svc, app[1], payload, user,
                               "Your Slack account isn't linked to Kritvia. Link it from Account in Kritvia.")
        return None
    if aid == "kv_change":
        try:
            await svc.slack.api(app[1], "views.open", {"trigger_id": payload.get("trigger_id"), "view": {
                "type": "modal", "callback_id": "kv_change", "private_metadata": f"{venture_id}:{approval_id}",
                "title": {"type": "plain_text", "text": "Ask for changes"},
                "submit": {"type": "plain_text", "text": "Send back"},
                "close": {"type": "plain_text", "text": "Cancel"},
                "blocks": [{"type": "input", "block_id": "change", "label": {"type": "plain_text",
                                                                          "text": "What should change?"},
                            "element": {"type": "plain_text_input", "action_id": "note", "multiline": True,
                                        "max_length": 2000}}]}})
        except slack.SlackError:
            pass
        return None
    ok, said = await decide_as(found.user_id, venture_id, approval_id, "approve" if aid == "kv_yes" else "reject",
                               None, svc)
    if not ok:
        await _slack_ephemeral(svc, app[1], payload, user, said)
    return None


def _ids(value: Any) -> tuple[uuid.UUID | None, uuid.UUID | None]:
    try:
        v, a = str(value or "").split(":")
        return uuid.UUID(v), uuid.UUID(a)
    except ValueError:
        return None, None


async def _slack_person(team: str, venture_id: uuid.UUID, user: str):
    from kritvia_api.services import slack
    if await slack.app_token(venture_id, team) is None:
        return None
    link = await approver(venture_id, "slack", user)
    return link if link is not None else None


async def _slack_ephemeral(svc, bot: str, payload: dict, user: str, msg: str) -> None:
    from kritvia_api.services import slack
    channel = (payload.get("channel") or {}).get("id") or (payload.get("container") or {}).get("channel_id")
    if not channel:
        return
    try:
        await svc.slack.api(bot, "chat.postEphemeral", {"channel": channel, "user": user, "text": msg})
    except slack.SlackError:
        pass


async def _slack_link(team: str, user: str, value: str, payload: dict, svc) -> None:
    from kritvia_api.services import slack
    try:
        v, code = value.split(":", 1)
        venture_id = uuid.UUID(v)
    except ValueError:
        return
    app = await slack.app_token(venture_id, team)
    if app is None:
        return
    async with tenant_tx(None, "system") as conn:
        who = (await conn.execute(text(
            "SELECT * FROM private.redeem_approver_link_code(:v, 'slack', :h, :x, :t, :l)"),
            {"v": venture_id, "h": code_hash(code[:64]), "x": user[:64], "t": team[:64],
             "l": str((payload.get("user") or {}).get("username") or "Slack")[:120]})).first()
    msg = ("Linked. Drafts that need your yes will arrive here with Approve, Reject and Ask for changes."
           if who else "That link has expired. In Kritvia, open Account and tap Link Slack again.")
    container = payload.get("container") or {}
    try:
        if container.get("channel_id") and container.get("message_ts"):
            await svc.slack.api(app[1], "chat.update", {"channel": container["channel_id"], "ts": container["message_ts"],
                                                        "text": msg, "blocks": []})
    except slack.SlackError:
        pass
