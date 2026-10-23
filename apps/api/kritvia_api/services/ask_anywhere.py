"""Ask Kritvia from anywhere: the email and Slack doors of the owner-side front door (services/front_door.py).

Email
  Each person gets a private ask address per business: ask-<128 random bits, base32>@<inbound domain>. Only its
  sha256 is stored (migration 0076); the full address is shown once. Mail to it arrives through the same
  Cloudflare email worker as forwarding (routers/email_in.py) and is answered only when
    * Cloudflare verified the From domain (the S15 verdict is "pass"), and
    * From is that person's own account email.
  Anything else is dropped silently (logged, security event) and never answered or bounced. The answer goes to
  the person's ACCOUNT email, never to an address taken from the message, as "Re: <subject>" in the same thread.

Slack
  A direct message to Kritvia's Slack app, or a mention of it, from a Slack member linked in Account (the same
  link that brings approval cards). Signed by Slack (routers/chat_approvals.py: POST /hooks/slack/events).
  Members who aren't linked get a one-line hint. Slack retries an event it thinks wasn't delivered: each
  event_id is taken once.

Both start the Kritvia assistant as that person (their history, their role checks), the same as Telegram and
WhatsApp. Commands work too: /today, /week, /waiting, /help.
"""
from __future__ import annotations

import base64
import hashlib
import logging
import re
import secrets
import uuid
from typing import Any

from sqlalchemy import text

from kritvia_api.db.session import tenant_tx

log = logging.getLogger(__name__)
PREFIX = "ask-"
MENTION = re.compile(r"<@[A-Z0-9]+(?:\|[^>]*)?>")
QUOTE_START = re.compile(
    r"^(>|On .{4,200} wrote:\s*$|-{2,} ?Original Message ?-{2,}|_{5,}|From: .+|Sent from my |Get Outlook for )",
    re.I)
SIGNATURE = re.compile(r"^(-- ?|—)$")
COMMANDS = ("/today", "/week", "/waiting", "/help")
FOOTER = ("You asked {business} by email at your private Kritvia address. To stop, remove that address in "
          "Kritvia → Account → Ask Kritvia from anywhere.")


# ------------------------------------------------------------------ addresses --
def new_local() -> str:
    """ask-<26 base32 characters> (128 random bits, lowercase so mail systems keep it as it is)."""
    return PREFIX + base64.b32encode(secrets.token_bytes(16)).decode().rstrip("=").lower()


def local_hash(local: str) -> str:
    return hashlib.sha256(local.strip().lower().encode()).hexdigest()


def is_ask_local(local: str | None) -> bool:
    return bool(local) and local.startswith(PREFIX)


# ------------------------------------------------------------------- requests --
def clean_body(body: str) -> str:
    """The new text of a reply: quoted history and the signature cut off, crudely."""
    out: list[str] = []
    for line in (body or "").replace("\r\n", "\n").split("\n"):
        s = line.strip()
        if QUOTE_START.match(s) or SIGNATURE.match(s):
            break
        out.append(line.rstrip())
    return "\n".join(out).strip()[:4000]


def strip_re(subject: str) -> str:
    s = (subject or "").strip()
    while True:
        m = re.match(r"^(re|fwd?|aw|wg)\s*:\s*", s, re.I)
        if not m:
            return s
        s = s[m.end():]


def email_request(subject: str, body: str) -> str:
    """What the person asked: a command (from the subject or the body's first line), else subject + body."""
    sub, b = strip_re(subject), clean_body(body)
    first = b.split("\n", 1)[0].strip().lower() if b else ""
    for c in COMMANDS:
        if sub.lower().startswith(c) or first.startswith(c):
            return c
    if not b:
        return sub[:4000]
    if not sub or sub.lower() in b.lower()[:200]:
        return b
    return f"{sub}\n\n{b}"[:4000]


# ---------------------------------------------------------------------- email --
async def email_ask(svc, local: str, address: str, msg, *, request_ip: str | None = None) -> str:
    """One mail to an ask address (already signature-checked by the email worker). Returns what happened:
    unknown (no such address: the caller answers 404), ignored (dropped silently) or taken."""
    from kritvia_api.services import front_door
    from kritvia_api.services.security_log import security_event
    async with tenant_tx(None, "system") as conn:
        p = (await conn.execute(text("SELECT * FROM private.ask_address_principal(:h)"),
                                {"h": local_hash(local)})).first()
    if p is None:
        return "unknown"
    sender = (msg.sender_email or "").lower()
    if msg.auth != "pass" or sender != (p.email or ""):
        log.info("ask address: dropped a mail (auth %s, from matches: %s)", msg.auth, sender == p.email)
        await security_event("ask_email.rejected", "warning", org_id=p.org_id,
                             reason="unverified sender" if msg.auth != "pass" else "not the owner's address")
        return "ignored"
    async with tenant_tx(None, "system") as conn:
        first = bool((await conn.execute(text("SELECT private.front_door_first('email', :r)"),
                                         {"r": f"{p.address_id}:{msg.id}"})).scalar())
        if first:
            await conn.execute(text("SELECT private.ask_address_used(:a)"), {"a": p.address_id})
    if not first:
        return "ignored"
    note = ("I can't read attachments here yet; I used the text of your email." if msg.attachments else None)
    target = {"subject": strip_re(msg.subject) or "Your question", "message_id": msg.id[:300],
              "address": address[:254], **({"note": note} if note else {})}
    a = front_door.Asker("email", p.venture_id, p.user_id, str(p.address_id),
                         "email:" + hashlib.sha256(msg.id.encode()).hexdigest()[:40], p.business, target=target)
    request = email_request(msg.subject, msg.body)

    async def say(body: str) -> None:
        await email_reply(p.venture_id, a.reply_target(), body)

    async def resend(ids: list[uuid.UUID]) -> None:
        await say(await waiting_list(p.venture_id, p.user_id, ids))

    await front_door.handle(svc, a, text_=request, say=say, resend_cards=resend)
    return "taken"


async def email_reply(venture_id: uuid.UUID, target: dict[str, Any], body: str) -> None:
    """An answer by email, to the person's account address, only while the ask address is still theirs."""
    from kritvia_api.services.mailer import get_mailer
    aid = str(target.get("chat") or "")
    try:
        uuid.UUID(aid)
    except ValueError:
        return
    async with tenant_tx(None, "system") as conn:
        o = (await conn.execute(text("SELECT * FROM private.ask_address_owner(:a)"), {"a": aid})).first()
        business = (await conn.execute(text("SELECT name FROM ventures WHERE id = :v"), {"v": venture_id})).scalar()
    if o is None or str(o.user_id) != str(target.get("user") or "") or o.venture_id != venture_id or not o.email:
        return
    subject = str(target.get("subject") or "Your question")[:180]
    note = target.get("note")
    text_ = body.strip() + (f"\n\n({note})" if note else "") + "\n\n" + FOOTER.format(business=business or "Kritvia")
    mid = str(target.get("message_id") or "")
    headers = {"In-Reply-To": mid, "References": mid} if mid.startswith("<") else None
    await get_mailer().send(o.email, f"Re: {subject}", text_, headers=headers,
                            reply_to=str(target.get("address") or "") or None)


async def waiting_list(venture_id: uuid.UUID, user_id: uuid.UUID, ids: list[uuid.UUID]) -> str:
    """/waiting by email: the drafts' titles with a link each (email has no buttons)."""
    from kritvia_api.config import get_settings
    base = get_settings().public_web_url.rstrip("/")
    async with tenant_tx(user_id) as conn:
        rows = (await conn.execute(text("SELECT id, title FROM approvals WHERE venture_id = :v AND id = ANY(:ids)"
                                        " ORDER BY created_at"), {"v": venture_id, "ids": ids})).all()
    return "Waiting for your yes:\n" + "\n".join(f"• {r.title}\n  {base}/inbox?id={r.id}" for r in rows)


# ---------------------------------------------------------------------- Slack --
async def slack_event(payload: dict[str, Any], svc) -> None:
    """One signed Slack event (the router answered url_verification and dropped retries)."""
    from kritvia_api.services import chat_approvals, front_door, slack
    team = str(payload.get("team_id") or "")
    ev = payload.get("event") or {}
    if not team or not isinstance(ev, dict):
        return
    kind = ev.get("type")
    if kind == "message" and ev.get("channel_type") != "im":
        return
    if kind not in ("message", "app_mention"):
        return
    if ev.get("bot_id") or ev.get("subtype") or not ev.get("user"):
        return                                          # the app's own posts, edits, joins…
    user, channel = str(ev["user"]), str(ev.get("channel") or "")
    if not channel:
        return
    event_id = str(payload.get("event_id") or ev.get("client_msg_id") or ev.get("ts") or "")
    async with tenant_tx(None, "system") as conn:
        if event_id and not (await conn.execute(text("SELECT private.front_door_first('slack', :r)"),
                                                {"r": f"{team}:{event_id}"})).scalar():
            return
        targets = (await conn.execute(text("SELECT * FROM private.slack_ask_targets(:t, :u)"),
                                      {"t": team, "u": user})).all()
        any_venture = targets[0].venture_id if targets else (await conn.execute(
            text("SELECT private.slack_team_venture(:t)"), {"t": team})).scalar()
    if any_venture is None:
        return
    app = await slack.app_token(any_venture, team)
    if app is None:
        return
    bot = app[1]
    thread = str(ev.get("thread_ts") or (ev.get("ts") if kind == "app_mention" else "") or "") or None
    said = MENTION.sub("", str(ev.get("text") or "")).strip()

    async def post(body: str) -> None:
        await slack_post(svc, bot, channel, body, thread)

    if not targets:
        await post("Link your Slack in Kritvia first: open Account → Ask Kritvia from anywhere → Link Slack.")
        return
    chosen = targets[0] if len(targets) == 1 else None
    if chosen is None:
        for t in targets:
            name = (t.business or "").strip()
            if name and said.lower().startswith(name.lower() + ":"):
                chosen, said = t, said[len(name) + 1:].strip()
                break
    if chosen is None:
        names = ", ".join(t.business for t in targets)
        await post(f"You're linked to more than one business ({names}). Start with its name and a colon, e.g. "
                   f"\"{targets[0].business}: kitne paise aaye?\"")
        return
    a = front_door.Asker("slack", chosen.venture_id, chosen.user_id, user, f"slack:{event_id or ev.get('ts')}",
                         chosen.business, target={"team": team, "slack_channel": channel,
                                                  **({"thread_ts": thread} if thread else {})})

    async def resend(ids: list[uuid.UUID]) -> None:
        for aid in ids:
            await chat_approvals.slack_card_to(chosen.venture_id, aid, bot, channel)

    await front_door.handle(svc, a, text_=said, say=post, resend_cards=resend)


async def slack_post(svc, bot: str, channel: str, body: str, thread: str | None = None) -> None:
    from kritvia_api.services import slack
    try:
        await svc.slack.api(bot, "chat.postMessage", {"channel": channel, "text": body[:3900],
                                                     "unfurl_links": False, "unfurl_media": False,
                                                     **({"thread_ts": thread} if thread else {})})
    except slack.SlackError:
        log.info("ask by Slack: posting the answer failed")


async def slack_reply(venture_id: uuid.UUID, target: dict[str, Any], body: str) -> None:
    """The assistant's answer back in Slack, only while that Slack member is still linked to the person."""
    from kritvia_api.engine.context import get_services
    from kritvia_api.services import slack
    from kritvia_api.services.chat_approvals import approver
    member, team, channel = str(target.get("chat") or ""), str(target.get("team") or ""), str(target.get("slack_channel") or "")
    if not member or not team or not channel:
        return
    link = await approver(venture_id, "slack", member)
    if link is None or str(link.user_id) != str(target.get("user") or ""):
        return
    app = await slack.app_token(venture_id, team)
    if app is None:
        return
    await slack_post(get_services(), app[1], channel, body, target.get("thread_ts"))
