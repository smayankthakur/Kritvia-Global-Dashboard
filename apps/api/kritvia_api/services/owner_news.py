"""Telling a business's owners and admins something that needs them: a push to their phones, Telegram for
those who linked it (Approve from your phone), email for the others. Used by the morning self-check and the
"drafts about to expire" nudges. Messages say what needs attention and link to it; no customer content.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass

from sqlalchemy import text

log = logging.getLogger(__name__)


@dataclass
class Told:
    push: int = 0
    telegram: int = 0
    email: int = 0

    @property
    def anyone(self) -> bool:
        return bool(self.push or self.telegram or self.email)


async def tell_admins(services, conn, venture_id: uuid.UUID, *, subject: str, body: str, path: str,
                      tag: str) -> Told:
    """`conn` reads as someone who can see the business (the owner, in the worker)."""
    from kritvia_api.config import get_settings
    from kritvia_api.services import chat_approvals, push
    from kritvia_api.services.mailer import get_mailer
    from kritvia_api.services.telegram import TelegramError
    told = Told()
    people = (await conn.execute(text("SELECT * FROM private.venture_admin_people(:v)"), {"v": venture_id})).all()
    chats = {r.user_id: r.external_id for r in (await conn.execute(text(
        "SELECT user_id, external_id FROM approver_links WHERE venture_id = :v AND channel = 'telegram'"),
        {"v": venture_id})).all()}
    try:
        told.push = await push.notify_venture(venture_id, title=subject, body=body.split("\n", 1)[0], url=path,
                                              tag=tag)
    except Exception:  # noqa: BLE001 - a push service problem never stops the message
        log.info("owner news: push failed", exc_info=True)
    bot = await chat_approvals.telegram_bot(venture_id) if chats else None
    link = get_settings().public_web_url.rstrip("/") + path
    for p in people:
        chat = chats.get(p.user_id)
        if bot is not None and chat:
            try:
                await services.telegram.call(bot.token, "sendMessage",
                                             {"chat_id": int(chat), "text": f"{subject}\n\n{body}\n\n{link}"[:4000]})
                told.telegram += 1
                continue
            except TelegramError as exc:
                log.info("owner news: Telegram didn't take it (%s)", exc)
        if p.email:
            try:
                await get_mailer().send(p.email, subject, f"{body}\n\nOpen Kritvia: {link}\n\n"
                                                          "Kritvia. To get these in Telegram and approve drafts "
                                                          "with one tap: Your account, Approve from your phone.")
                told.email += 1
            except Exception:  # noqa: BLE001
                log.info("owner news: email failed", exc_info=True)
    return told
