"""Run the business from Telegram, WhatsApp, Email or Slack ("the front door", owner side).

A team member links their own chat once (Account → Ask Kritvia from anywhere): Telegram and WhatsApp by a
one-time code, Slack by a confirmation DM, and email by a private ask address (services/ask_anywhere.py,
which also handles the email and Slack doors). From then on, in that chat:

  a message      -> the Kritvia assistant, as that person ("Pichle hafte kitne leads aaye?", "Send Priya the
                    proposal follow-up"); the answer comes back in the same chat. Drafts it makes arrive
                    there as cards with Approve / Reject / Ask for changes, decided as that person.
  a voice note   -> transcribed (Hindi, Hinglish, English and more; the business's own vocabulary as hints),
                    echoed back as "Heard: …", then handled like a message.
  /today /week   -> the business's numbers (code-computed, no AI): money in, to collect, overdue,
                    bookings, leads, drafts waiting.
  /waiting       -> the drafts waiting for this person, sent again as cards.
  /help          -> what can be done here.

Nothing here gives anyone more than the app does: requests run as the linked person (their own
assistant history, their role checks on every draft), and links are made only by sending a one-time
code from the chat itself. WhatsApp only allows free-form messages for 24 hours after the person last
wrote, so answers and cards go to WhatsApp only inside that window.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Awaitable, Callable

from sqlalchemy import text

from kritvia_api.db.session import tenant_tx

log = logging.getLogger(__name__)
WINDOW = timedelta(hours=24)
MAX_VOICE_BYTES = 10 * 1024 * 1024
HELP = ("Ask me anything about {business} in Hindi, Hinglish or English, by message or voice note. For example:\n"
        "• Is hafte kitna paisa aaya?\n"
        "• Which leads came in today, and who should I call first?\n"
        "• Priya ko proposal ka follow-up bhejo\n"
        "• Add a task for Neha to send the Acme quote by Friday\n\n"
        "Anything that sends, books or changes something comes back here as a draft for your yes.\n"
        "Quick: /today, /week, /waiting, /skills, /run <skill name>, /help")

Say = Callable[[str], Awaitable[None]]


@dataclass
class Asker:
    """A linked person writing from their chat."""
    channel: str              # telegram | whatsapp | email | slack
    venture_id: uuid.UUID
    user_id: uuid.UUID
    chat: str                 # Telegram chat id / WhatsApp number (digits) / ask address id / Slack member id
    message_id: str           # for dedupe
    business: str | None
    target: dict[str, Any] | None = None    # extra fields the answer needs (email thread, Slack channel)

    def reply_target(self) -> dict[str, Any]:
        """Where the answer goes: back to this chat, for this person (front_door.reply checks both again)."""
        return {**(self.target or {}), "channel": self.channel, "chat": self.chat, "user": str(self.user_id)}


def command(text_: str) -> str | None:
    w = text_.strip().split()
    if not w or not w[0].startswith("/"):
        return None
    c = w[0][1:].split("@", 1)[0].lower()
    return c if c in ("today", "week", "waiting", "help", "start", "skills", "run") else "unknown"


async def numbers(venture_id: uuid.UUID, user_id: uuid.UUID, period: str) -> str:
    """The business's numbers for a period, as the person (their access), in plain lines."""
    from zoneinfo import ZoneInfo

    from kritvia_api.services import automations as au
    async with tenant_tx(user_id) as conn:
        tz_name = (await conn.execute(text("SELECT timezone FROM venture_settings WHERE venture_id = :v"),
                                      {"v": venture_id})).scalar()
        try:
            tz = ZoneInfo(tz_name or "Asia/Kolkata")
        except Exception:
            tz = ZoneInfo("Asia/Kolkata")
        start, end = au.period_range(period, tz, datetime.now(tz))
        lines = await au.facts(conn, venture_id, start, end)
    return f"{au.PERIOD_WORDS[period].capitalize()}:\n{lines}"[:3800]


async def waiting(venture_id: uuid.UUID, user_id: uuid.UUID) -> list[uuid.UUID]:
    """Drafts this person could decide, oldest first (at most 5)."""
    async with tenant_tx(user_id) as conn:
        rows = (await conn.execute(text(
            "SELECT a.id FROM approvals a WHERE a.venture_id = :v AND a.status = 'pending'"
            " AND EXISTS (SELECT 1 FROM private.approval_chat_targets(a.id, 'telegram') t WHERE t.user_id = :u"
            "             UNION SELECT 1 FROM private.approval_chat_targets(a.id, 'whatsapp') t WHERE t.user_id = :u"
            "             UNION SELECT 1 FROM private.approval_chat_targets(a.id, 'slack') t WHERE t.user_id = :u)"
            " ORDER BY a.created_at LIMIT 5"), {"v": venture_id, "u": user_id})).all()
    return [r.id for r in rows]


async def can_ask(venture_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    """The same rule as the Assistant page: starting work needs write access to the business."""
    async with tenant_tx(user_id) as conn:
        return bool((await conn.execute(text("SELECT :v = ANY (private.writable_ventures())"),
                                        {"v": venture_id})).scalar())


async def ask_assistant(svc, a: Asker, request: str) -> str:
    """Starts an assistant request as the person; its answer comes back to this chat. Returns "ok",
    "duplicate" (this message was already taken: a redelivery) or "off" (the assistant can't run)."""
    from kritvia_api.engine.runner import DuplicateTrigger, start_run
    try:
        await start_run(svc, actor_user_id=a.user_id, actor_type="user", venture_id=a.venture_id,
                        workflow="assistant", trigger_kind=a.channel, trigger_ref=a.message_id[:200],
                        title="Assistant request",
                        input={"request": request.strip()[:4000], "reply_to": a.reply_target()})
    except DuplicateTrigger:
        return "duplicate"
    except ValueError as exc:
        log.info("front door: assistant didn't start for %s: %s", a.venture_id, exc)
        return "off"
    return "ok"


async def transcribe(svc, a: Asker, audio: bytes, filename: str) -> str:
    """A voice note -> text, with the business's vocabulary as hints (same path as dictation)."""
    from kritvia_api.routers.voice import dictate
    out = await dictate(venture_id=a.venture_id, user_id=a.user_id, svc=svc, data=audio, filename=filename,
                        sensitive=False, language=None, engine=None, mode="ask", surface=a.channel,
                        duration_ms=None)
    return out.text.strip()


async def handle(svc, a: Asker, *, text_: str, say: Say, resend_cards: Callable[[list[uuid.UUID]], Awaitable[None]],
                 audio: Callable[[], Awaitable[tuple[bytes, str] | None]] | None = None) -> None:
    """One message (or voice note) from a linked person."""
    if audio is not None:
        got = await audio()
        if got is None:
            await say("I couldn't get that voice note. Try again, or type it.")
            return
        try:
            heard = await transcribe(svc, a, *got)
        except Exception as exc:   # noqa: BLE001 - speech service down, policy, too short…
            log.info("front door: transcription failed: %s", exc)
            await say("I couldn't understand that voice note. Try again, or type it.")
            return
        if not heard:
            await say("That voice note was empty. Try again, a little closer to the phone.")
            return
        await say(f"Heard: {heard[:600]}")
        text_ = heard
    c = command(text_)
    if c in ("help", "start", "unknown"):
        await say(HELP.format(business=a.business or "your business"))
        return
    if c in ("today", "week"):
        await say(await numbers(a.venture_id, a.user_id, "today" if c == "today" else "last_7_days"))
        return
    if c == "skills":
        await say(await skill_list(a))
        return
    if c == "run":
        await say(await run_skill(svc, a, text_.strip().split(None, 1)[1] if len(text_.strip().split(None, 1)) > 1 else ""))
        return
    if c == "waiting":
        ids = await waiting(a.venture_id, a.user_id)
        if not ids:
            await say("Nothing is waiting for your yes.")
            return
        await say(f"{len(ids)} draft(s) waiting for your yes:" if len(ids) < 5 else "The 5 oldest drafts waiting for your yes:")
        await resend_cards(ids)
        return
    if not text_.strip():
        await say(HELP.format(business=a.business or "your business"))
        return
    if not await can_ask(a.venture_id, a.user_id):
        await say("You decide drafts here (and /today, /waiting work for you). Asking the business to do things needs "
                  "an operator or admin role; ask an admin of the business in Kritvia.")
        return
    started = await ask_assistant(svc, a, text_)
    if started == "ok":
        if a.channel != "email":           # by email, one answer is enough
            await say("On it.")
    elif started == "off":
        await say("The Kritvia assistant can't take requests for this business right now. Check its plan, or ask "
                  "an admin to switch it on in Agents.")


async def skill_list(a: Asker) -> str:
    from kritvia_api.services import skills as sk
    async with tenant_tx(a.user_id) as conn:
        rows = (await conn.execute(text("SELECT name, trigger, freq, weekdays, day_of_month, at_time, event, wait_days,"
                                        " enabled FROM skills WHERE venture_id = :v ORDER BY name"),
                                   {"v": a.venture_id})).all()
    if not rows:
        return "No skills yet. Make one in Kritvia → Automations → Skills, or save a request that worked as a skill."
    return "Skills:\n" + "\n".join(f"• {r.name}: {sk.describe(dict(r._mapping))}" + ("" if r.enabled else " (off)")
                                   for r in rows) + "\n\nRun one with /run <name>."


async def run_skill(svc, a: Asker, name: str) -> str:
    from kritvia_api.services import skills as sk
    from kritvia_api.services.crypto import EnvelopeCrypto
    if not name.strip():
        return "Say which: /run <skill name>. /skills lists them."
    if not await can_ask(a.venture_id, a.user_id):
        return "Running skills needs an operator or admin role."
    async with tenant_tx(a.user_id) as conn:
        hits = (await conn.execute(text("SELECT id FROM skills WHERE venture_id = :v AND name ILIKE :n ORDER BY name"),
                                   {"v": a.venture_id, "n": "%" + name.strip().replace("%", "")[:80] + "%"})).scalars().all()
        if len(hits) != 1:
            return "No skill by that name. /skills lists them." if not hits else "More than one skill matches; say more of its name."
        s = await sk.load(conn, EnvelopeCrypto(conn, svc.keys), a.venture_id, hits[0])
    try:
        await sk.start(svc, s, actor_user_id=a.user_id, actor_type="user", trigger_kind=a.channel,
                       reply_to=a.reply_target())
    except ValueError:
        return "That skill can't run right now. Check it in Kritvia."
    return f"Running \"{s['name']}\"."


# ------------------------------------------------------------- answers back --
async def reply(venture_id: uuid.UUID, target: dict[str, Any], body: str) -> None:
    """The assistant's answer, back in the chat the request came from (best effort), only while that
    chat is still linked to the person who asked."""
    from kritvia_api.services.chat_approvals import approver
    try:
        ch, chat, who = str(target.get("channel") or ""), str(target.get("chat") or ""), str(target.get("user") or "")
        if not chat or not body.strip():
            return
        if ch in ("email", "slack"):
            from kritvia_api.services import ask_anywhere
            await (ask_anywhere.email_reply if ch == "email" else ask_anywhere.slack_reply)(venture_id, target, body)
            return
        if ch not in ("telegram", "whatsapp"):
            return
        link = await approver(venture_id, ch, chat)
        if link is None or str(link.user_id) != who:
            return
        if ch == "telegram":
            await _telegram_say(venture_id, chat, body)
        else:
            await whatsapp_say(venture_id, link.user_id, chat, body)
    except Exception:  # noqa: BLE001 - an answer that can't be delivered stays in the app
        log.exception("front door: reply failed for %s", venture_id)


async def _telegram_say(venture_id: uuid.UUID, chat: str, body: str) -> None:
    from kritvia_api.engine.context import get_services
    from kritvia_api.services.chat_approvals import telegram_bot
    from kritvia_api.services.telegram import TelegramError
    bot = await telegram_bot(venture_id)
    if bot is None:
        return
    try:
        await get_services().telegram.call(bot.token, "sendMessage", {"chat_id": int(chat), "text": body[:4000]})
    except (TelegramError, ValueError):
        pass


@dataclass
class WaNumber:
    run_as: uuid.UUID
    org_id: uuid.UUID
    conn: Any                 # services.whatsapp.WhatsAppConn
    business: str | None


async def whatsapp_number(venture_id: uuid.UUID) -> WaNumber | None:
    from kritvia_api.services.crypto import EnvelopeCrypto
    from kritvia_api.services.whatsapp import WhatsAppConn
    from kritvia_api.engine.context import get_services
    async with tenant_tx(None, "system") as conn:
        b = (await conn.execute(text("SELECT * FROM private.whatsapp_number_for(:v)"), {"v": venture_id})).first()
    if b is None:
        return None
    async with tenant_tx(b.run_as, "agent", "whatsapp") as conn:
        row = (await conn.execute(text(
            "SELECT c.id, c.external_id, c.account_email, t.secret_enc, v.name AS business FROM connectors c"
            " JOIN connector_tokens t ON t.connector_id = c.id JOIN ventures v ON v.id = c.venture_id"
            " WHERE c.id = :c"), {"c": b.connector_id})).first()
        if row is None:
            return None
        token = await EnvelopeCrypto(conn, get_services().keys).decrypt_str(venture_id, "connector.secret", row.secret_enc)
    if not token:
        return None
    return WaNumber(b.run_as, b.org_id, WhatsAppConn(row.id, row.external_id or "", row.account_email, token),
                    row.business)


async def in_window(venture_id: uuid.UUID, user_id: uuid.UUID, run_as: uuid.UUID) -> bool:
    async with tenant_tx(run_as, "agent", "whatsapp") as conn:
        at = (await conn.execute(text(
            "SELECT last_inbound_at FROM approver_links WHERE venture_id = :v AND channel = 'whatsapp' AND user_id = :u"),
            {"v": venture_id, "u": user_id})).scalar()
    return at is not None and datetime.now(UTC) - at < WINDOW


async def whatsapp_say(venture_id: uuid.UUID, user_id: uuid.UUID | None, chat: str, body: str,
                       buttons: list[tuple[str, str]] | None = None, *, check_window: bool = True) -> str | None:
    """Sends to a linked person's WhatsApp (inside the 24-hour window). Returns the message id."""
    from kritvia_api.engine.context import get_services
    from kritvia_api.services.whatsapp import WhatsAppError
    n = await whatsapp_number(venture_id)
    if n is None:
        return None
    if check_window and user_id is not None and not await in_window(venture_id, user_id, n.run_as):
        return None
    wa = get_services().whatsapp
    try:
        if buttons:
            return await wa.send_buttons(n.conn, to=chat, body=body, buttons=buttons)
        return await wa.send_text(n.conn, to=chat, body=body)
    except WhatsAppError:
        return None
