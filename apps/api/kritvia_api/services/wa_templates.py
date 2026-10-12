"""Sending a business's approved WhatsApp templates on an agent's behalf (after a person's yes).

The rules every template send follows, whoever asks for it (the follow-up agent, the assistant):
  * only to someone who agreed to hear from the business: they wrote first, or a team member
    confirmed it when starting the chat (`wa_contacts.opted_in_at`); never to a cold number;
  * never to someone who wrote STOP;
  * only templates WhatsApp approved and Kritvia can send (body text only);
  * every blank filled in, without new lines (WhatsApp refuses those).
The text shown on the approval card is rendered from the template and the blanks; the send renders it
again from the same template, so what goes out is exactly what was approved.
"""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import text

from kritvia_api.services import wa_inbox
from kritvia_api.services.whatsapp import check_param, render_template


class TemplateProblem(Exception):
    """Why a template can't be sent; shown to people and to agents as is."""


@dataclass
class Template:
    id: uuid.UUID
    name: str
    language: str
    category: str
    body: str
    params: int
    examples: list[str]
    status: str
    sendable: bool

    @property
    def title(self) -> str:
        s = self.name.replace("_", " ").strip()
        return s[:1].upper() + s[1:]


COLS = "id, name, language, category, body, params, examples, status, sendable"


def _key(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", (name or "").lower()).strip("_")


async def by_id(conn, venture_id: uuid.UUID, template_id: uuid.UUID | str) -> Template | None:
    try:
        tid = uuid.UUID(str(template_id))
    except ValueError:
        return None
    r = (await conn.execute(text(f"SELECT {COLS} FROM wa_templates WHERE id = :id AND venture_id = :v"),
                            {"id": tid, "v": venture_id})).first()
    return Template(**r._mapping) if r else None


async def by_name(conn, venture_id: uuid.UUID, name: str) -> Template | None:
    """A template by the name the team sees ('Order ready' or 'order_ready'); approved ones first,
    English before other languages when several share the name."""
    rows = (await conn.execute(text(f"SELECT {COLS} FROM wa_templates WHERE venture_id = :v AND name = :n"
                                    " ORDER BY (status = 'APPROVED') DESC, (language LIKE 'en%') DESC"),
                               {"v": venture_id, "n": _key(name)})).all()
    return Template(**rows[0]._mapping) if rows else None


async def approved(conn, venture_id: uuid.UUID) -> list[Template]:
    rows = (await conn.execute(text(f"SELECT {COLS} FROM wa_templates WHERE venture_id = :v"
                                    " AND status = 'APPROVED' AND sendable ORDER BY name"), {"v": venture_id})).all()
    return [Template(**r._mapping) for r in rows]


def render(t: Template | None, params: list[Any]) -> tuple[str, list[str]]:
    """(the text the customer gets, the cleaned blanks), or TemplateProblem."""
    if t is None:
        raise TemplateProblem("there is no template with that name; see WhatsApp → Templates")
    if t.status != "APPROVED":
        raise TemplateProblem(f"WhatsApp hasn't approved the template '{t.title}' (it is {t.status.lower()})")
    if not t.sendable:
        raise TemplateProblem(f"'{t.title}' needs a photo, link or code; it can only be sent from WhatsApp Manager")
    clean = [str(p).strip() for p in (params or [])]
    if len(clean) != t.params:
        raise TemplateProblem(f"'{t.title}' has {t.params} blank(s) to fill in; got {len(clean)}")
    for p in clean:
        if problem := check_param(p):
            raise TemplateProblem(problem)
    return render_template(t.body, clean), clean


async def recipient(conn, venture_id: uuid.UUID, phone: str) -> wa_inbox.Contact:
    """The chat an agent may write to, or TemplateProblem."""
    c = await wa_inbox.find_contact(conn, venture_id, phone)
    if c is None or not c.opted_in:
        raise TemplateProblem("WhatsApp only allows messages to people who agreed to hear from you: they wrote to "
                              "you first, or your team started the chat with their consent (WhatsApp → New chat)")
    if c.opted_out:
        raise TemplateProblem("this customer wrote STOP; nothing more is sent to them")
    return c
