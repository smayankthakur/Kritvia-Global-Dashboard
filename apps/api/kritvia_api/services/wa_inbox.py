"""WhatsApp conversations: one thread per customer number, every message kept (encrypted).

The webhook records each inbound message here before anything else happens; agent replies and
replies typed by a person are recorded when they are sent. Agents read the recent thread so a
reply answers the whole conversation, not just the last line.

Rules this module enforces:
  * WhatsApp only allows free-form messages within 24 hours of the customer's last message
    (`window_open`). Outside it a send is refused here, with a clear reason, before Meta is asked.
  * A chat a person has taken over (`handled_by = 'person'`) gets no automatic replies.
  * A customer who writes STOP (or similar) is opted out: messages are still kept, nobody is
    drafted a reply, and nothing more is sent to them.
"""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import text

from kritvia_api.services.crypto import EnvelopeCrypto

PURPOSE = "whatsapp.message"
WINDOW = timedelta(hours=24)
HISTORY = 12                    # messages an agent sees when drafting
_STOP = re.compile(r"^\s*(stop|unsubscribe|band karo|mat bhejo|message mat karo|no more messages)\s*[.!]*\s*$", re.I)


def digits(phone: str | None) -> str:
    return "".join(ch for ch in (phone or "") if ch.isdigit())


def is_stop(body: str) -> bool:
    return bool(_STOP.match(body or ""))


def window_open(last_inbound_at: datetime | None, now: datetime | None = None) -> bool:
    if last_inbound_at is None:
        return False
    return (now or datetime.now(timezone.utc)) - last_inbound_at < WINDOW


@dataclass
class Contact:
    id: uuid.UUID
    phone: str
    name: str | None
    handled_by: str
    opted_out: bool
    last_inbound_at: datetime | None
    lead_id: uuid.UUID | None

    @property
    def automatic(self) -> bool:
        """Kritvia may draft replies for this chat."""
        return self.handled_by == "kritvia" and not self.opted_out


def _contact(r) -> Contact:
    return Contact(r.id, r.phone, r.name, r.handled_by, r.opted_out_at is not None, r.last_inbound_at, r.lead_id)


COLS = "id, phone, name, handled_by, opted_out_at, last_inbound_at, lead_id"


async def find_contact(conn, venture_id: uuid.UUID, phone: str) -> Contact | None:
    r = (await conn.execute(text(f"SELECT {COLS} FROM wa_contacts WHERE venture_id = :v AND phone = :p"),
                            {"v": venture_id, "p": digits(phone)})).first()
    return _contact(r) if r else None


async def record_inbound(conn, crypto: EnvelopeCrypto, *, org_id: uuid.UUID, venture_id: uuid.UUID, phone: str,
                         name: str | None, body: str, kind: str, provider_id: str) -> tuple[Contact, bool]:
    """Stores one inbound message. Returns the contact and False when it was already stored (redelivery)."""
    phone = digits(phone)
    stop = is_stop(body)
    r = (await conn.execute(text(
        "INSERT INTO wa_contacts (org_id, venture_id, phone, name, last_inbound_at, last_message_at)"
        " VALUES (:o, :v, :p, :n, now(), now())"
        " ON CONFLICT (venture_id, phone) DO UPDATE SET name = coalesce(EXCLUDED.name, wa_contacts.name),"
        " updated_at = now()"
        f" RETURNING {COLS}"), {"o": org_id, "v": venture_id, "p": phone, "n": (name or None) and name[:120]})).first()
    enc = await crypto.encrypt(venture_id, PURPOSE, body[:20000])
    mid = (await conn.execute(text(
        "INSERT INTO wa_messages (org_id, venture_id, contact_id, direction, sent_by, kind, body_enc,"
        " provider_message_id, status) VALUES (:o, :v, :c, 'in', 'customer', :k, :b, :m, 'received')"
        " ON CONFLICT (venture_id, provider_message_id)"
        " WHERE provider_message_id IS NOT NULL AND provider_message_id <> '' DO NOTHING RETURNING id"),
        {"o": org_id, "v": venture_id, "c": r.id, "k": (kind or "text")[:20], "b": enc,
         "m": provider_id[:200]})).scalar()
    if mid is None:
        return _contact(r), False
    r = (await conn.execute(text(
        "UPDATE wa_contacts SET last_inbound_at = now(), last_message_at = now(), unread = unread + 1,"
        " opted_out_at = CASE WHEN :stop THEN coalesce(opted_out_at, now()) ELSE opted_out_at END,"
        " updated_at = now() WHERE id = :id"
        f" RETURNING {COLS}"), {"id": r.id, "stop": stop})).first()
    return _contact(r), True


async def record_outbound(conn, crypto: EnvelopeCrypto, *, org_id: uuid.UUID, venture_id: uuid.UUID, phone: str,
                          body: str, sent_by: str, status: str, provider_id: str | None = None,
                          error: str | None = None, approval_id: uuid.UUID | None = None,
                          user_id: uuid.UUID | None = None) -> None:
    phone = digits(phone)
    cid = (await conn.execute(text(
        "INSERT INTO wa_contacts (org_id, venture_id, phone, last_message_at) VALUES (:o, :v, :p, now())"
        " ON CONFLICT (venture_id, phone) DO UPDATE SET last_message_at = now(), updated_at = now() RETURNING id"),
        {"o": org_id, "v": venture_id, "p": phone})).scalar_one()
    enc = await crypto.encrypt(venture_id, PURPOSE, body[:20000])
    await conn.execute(text(
        "INSERT INTO wa_messages (org_id, venture_id, contact_id, direction, sent_by, body_enc, provider_message_id,"
        " status, error, approval_id, user_id) VALUES (:o, :v, :c, 'out', :by, :b, :m, :st, :e, :a, :u)"
        " ON CONFLICT (venture_id, provider_message_id)"
        " WHERE provider_message_id IS NOT NULL AND provider_message_id <> '' DO NOTHING"),
        {"o": org_id, "v": venture_id, "c": cid, "by": sent_by, "b": enc, "m": provider_id or None, "st": status,
         "e": (error or None) and error[:300], "a": approval_id, "u": user_id})


async def thread(conn, crypto: EnvelopeCrypto, venture_id: uuid.UUID, contact_id: uuid.UUID,
                 limit: int = 50) -> list[dict[str, Any]]:
    """The latest messages of one chat, oldest first."""
    rows = (await conn.execute(text(
        "SELECT id, direction, sent_by, kind, body_enc, status, error, created_at FROM wa_messages"
        " WHERE venture_id = :v AND contact_id = :c ORDER BY created_at DESC, id DESC LIMIT :l"),
        {"v": venture_id, "c": contact_id, "l": limit})).all()
    out = []
    for r in reversed(rows):
        out.append({"id": r.id, "direction": r.direction, "sent_by": r.sent_by, "kind": r.kind,
                    "body": await crypto.decrypt_str(venture_id, PURPOSE, r.body_enc) or "",
                    "status": r.status, "error": r.error, "created_at": r.created_at})
    return out


def transcript(messages: list[dict[str, Any]], business: str) -> str:
    """Plain transcript for a prompt. Failed sends are left out: the customer never saw them."""
    lines = []
    for m in messages:
        if m["status"] == "failed":
            continue
        who = "Customer" if m["direction"] == "in" else f"{business} ({'a person' if m['sent_by'] == 'person' else 'Kritvia'})"
        lines.append(f"[{m['created_at']:%d %b %H:%M}] {who}: {m['body'][:1500]}")
    return "\n".join(lines)


async def newer_inbound(conn, venture_id: uuid.UUID, phone: str, provider_id: str | None) -> bool:
    """True when the customer has written again after `provider_id`: that later message's run answers both."""
    if not provider_id:
        return False
    return (await conn.execute(text(
        "SELECT 1 FROM wa_messages m JOIN wa_contacts c ON c.id = m.contact_id"
        " WHERE m.venture_id = :v AND c.phone = :p AND m.direction = 'in'"
        "   AND m.created_at > (SELECT created_at FROM wa_messages WHERE venture_id = :v AND provider_message_id = :m)"
        " LIMIT 1"), {"v": venture_id, "p": digits(phone), "m": provider_id})).first() is not None


async def hand_to_person(conn, venture_id: uuid.UUID, contact_id: uuid.UUID, reason: str) -> None:
    await conn.execute(text(
        "UPDATE wa_contacts SET handled_by = 'person', handoff_reason = :r, handoff_at = now(), updated_at = now()"
        " WHERE id = :id AND venture_id = :v"), {"id": contact_id, "v": venture_id, "r": reason[:300]})


async def link_lead(conn, *, org_id: uuid.UUID, venture_id: uuid.UUID, contact: Contact,
                    run_id: uuid.UUID | None) -> uuid.UUID:
    """The chat's lead: the one already linked, one with the same phone, or a new one (source whatsapp)."""
    if contact.lead_id:
        return contact.lead_id
    lead_id = (await conn.execute(text(
        "SELECT id FROM leads WHERE venture_id = :v AND regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') = :p"
        " ORDER BY created_at DESC LIMIT 1"), {"v": venture_id, "p": contact.phone})).scalar()
    if lead_id is None:
        lead_id = (await conn.execute(text(
            "INSERT INTO leads (org_id, venture_id, name, source, phone, last_run_id)"
            " VALUES (:o, :v, :n, 'whatsapp', :p, :r) RETURNING id"),
            {"o": org_id, "v": venture_id, "n": (contact.name or f"WhatsApp +{contact.phone}")[:200],
             "p": "+" + contact.phone, "r": run_id})).scalar_one()
    await conn.execute(text("UPDATE wa_contacts SET lead_id = :l, updated_at = now() WHERE id = :id"),
                       {"l": lead_id, "id": contact.id})
    return lead_id


async def earlier_waiting_runs(conn, venture_id: uuid.UUID, contact_id: uuid.UUID,
                               current_run: uuid.UUID) -> list[uuid.UUID]:
    """Runs for this chat's earlier messages whose draft still waits for a yes. A new draft answers
    the whole chat, so those older drafts are withdrawn and the customer never gets two answers."""
    rows = (await conn.execute(text(
        "SELECT DISTINCT r.id FROM workflow_runs r"
        " JOIN wa_messages i ON i.venture_id = r.venture_id AND i.provider_message_id = r.trigger_ref"
        " WHERE r.venture_id = :v AND i.contact_id = :c AND r.trigger_kind = 'whatsapp'"
        "   AND r.workflow = 'inbox_assistant' AND r.status = 'waiting' AND r.id <> :me"),
        {"v": venture_id, "c": contact_id, "me": current_run})).all()
    return [r.id for r in rows]
