"""Outbound messaging for send-class tools (email, calendar invites).

Transport per venture: the venture's Google connector if it has the needed
scope; otherwise the configured fallback. The 'log' fallback records the
message in the outbox without sending — safe for dogfooding before Gmail is
connected, and it is shown as 'logged' (never 'sent') in the UI.

Every message, whatever the transport, is written to outbox_messages with the
body encrypted, keyed by approval id (unique), so an approval sends at most once.
"""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from sqlalchemy import text

from kritvia_api.services.google import SCOPES, GoogleClient
from kritvia_api.services.whatsapp import WhatsAppClient, WhatsAppError, load_whatsapp

if TYPE_CHECKING:
    from kritvia_api.engine.context import RunContext


class MessagingError(Exception):
    pass


@dataclass
class GoogleConn:
    id: uuid.UUID
    email: str | None
    scopes: list[str]
    refresh_token: str


async def load_google(ctx: RunContext, conn) -> GoogleConn | None:
    row = (await conn.execute(
        text("SELECT c.id, c.account_email, c.scopes, t.secret_enc FROM connectors c"
             " JOIN connector_tokens t ON t.connector_id = c.id"
             " WHERE c.venture_id = :v AND c.provider = 'google' AND c.status = 'active'"),
        {"v": ctx.venture_id})).first()
    if row is None:
        return None
    secret = await ctx.crypto(conn).decrypt_str(ctx.venture_id, "connector.secret", row.secret_enc)
    return GoogleConn(row.id, row.account_email, list(row.scopes), secret or "")


class Messaging:
    def __init__(self, google: GoogleClient | None, fallback: str = "log",
                 whatsapp: WhatsAppClient | None = None) -> None:
        if fallback not in ("log", "none"):
            raise ValueError("messaging fallback must be 'log' or 'none'")
        self.google, self.fallback, self.whatsapp = google, fallback, whatsapp

    async def _google_token(self, ctx: RunContext, scope: str) -> tuple[str, GoogleConn] | None:
        if self.google is None or not self.google.configured:
            return None
        async with ctx.tx() as conn:
            g = await load_google(ctx, conn)
        if g is None or SCOPES[scope] not in g.scopes:
            return None
        return await self.google.access_token(g.id, g.refresh_token), g

    async def _record(self, ctx: RunContext, approval_id: uuid.UUID, *, channel: str, recipient: str,
                      subject: str | None, body: str, transport: str, status: str,
                      provider_id: str | None = None, error: str | None = None) -> None:
        async with ctx.tx() as conn:
            enc = await ctx.crypto(conn).encrypt(ctx.venture_id, "outbox.body", body)
            await conn.execute(
                text("INSERT INTO outbox_messages (org_id, venture_id, approval_id, channel, recipient, subject,"
                     " body_enc, transport, status, provider_message_id, error)"
                     " VALUES (:o, :v, :a, :c, :r, :s, :b, :t, :st, :p, :e)"),
                {"o": ctx.org_id, "v": ctx.venture_id, "a": approval_id, "c": channel, "r": recipient[:500],
                 "s": (subject or "")[:500], "b": enc, "t": transport, "st": status, "p": provider_id,
                 "e": error})

    async def send_email(self, ctx: RunContext, approval_id: uuid.UUID, *, to: str, subject: str, body: str,
                         cc: list[str] | None = None, thread_id: str | None = None,
                         attachments: list[tuple[str, str, bytes]] | None = None) -> dict[str, Any]:
        if not to or "@" not in to:
            raise MessagingError("recipient email is missing or invalid")
        google = await self._google_token(ctx, "gmail.send")
        if google:
            token, g = google
            try:
                mid = await self.google.send_email(token, to=to, subject=subject, body=body, cc=cc,
                                                   thread_id=thread_id, sender=g.email, attachments=attachments)
            except Exception as exc:
                await self._record(ctx, approval_id, channel="email", recipient=to, subject=subject, body=body,
                                   transport="gmail", status="failed", error=str(exc)[:300])
                raise MessagingError(f"gmail send failed: {exc}") from exc
            await self._record(ctx, approval_id, channel="email", recipient=to, subject=subject, body=body,
                               transport="gmail", status="sent", provider_id=mid)
            return {"transport": "gmail", "status": "sent", "message_id": mid}
        if self.fallback == "log":
            await self._record(ctx, approval_id, channel="email", recipient=to, subject=subject,
                               body=body + (f"\n\n[attachments: {', '.join(a[0] for a in attachments)}]"
                                            if attachments else ""),
                               transport="log", status="logged")
            return {"transport": "log", "status": "logged"}
        raise MessagingError("no email connector for this venture (connect Google in Settings)")

    async def create_event(self, ctx: RunContext, approval_id: uuid.UUID, *, summary: str, start: str,
                           end: str, attendees: list[str], description: str = "") -> dict[str, Any]:
        google = await self._google_token(ctx, "calendar.events")
        recipient = ", ".join(attendees) or "(no attendees)"
        body = json.dumps({"start": start, "end": end, "description": description})
        if google:
            token, _ = google
            ev = await self.google.create_event(token, summary=summary, start=start, end=end,
                                                attendees=attendees, description=description)
            await self._record(ctx, approval_id, channel="calendar", recipient=recipient, subject=summary,
                               body=body, transport="google_calendar", status="sent", provider_id=ev["id"])
            return {"transport": "google_calendar", "status": "sent", "event_id": ev["id"], "link": ev["link"]}
        if self.fallback == "log":
            await self._record(ctx, approval_id, channel="calendar", recipient=recipient, subject=summary,
                               body=body, transport="log", status="logged")
            return {"transport": "log", "status": "logged"}
        raise MessagingError("no calendar connector for this venture (connect Google in Settings)")

    async def send_whatsapp(self, ctx: RunContext, approval_id: uuid.UUID, *, to: str, body: str) -> dict[str, Any]:
        if not to.strip():
            raise MessagingError("recipient phone number is missing")
        async with ctx.tx() as conn:
            wa = await load_whatsapp(ctx, conn)
        if wa and self.whatsapp is not None:
            try:
                mid = await self.whatsapp.send_text(wa, to=to, body=body)
            except WhatsAppError as exc:
                await self._record(ctx, approval_id, channel="whatsapp", recipient=to, subject=None, body=body,
                                   transport="whatsapp", status="failed", error=str(exc)[:300])
                raise MessagingError(str(exc)) from exc
            await self._record(ctx, approval_id, channel="whatsapp", recipient=to, subject=None, body=body,
                               transport="whatsapp", status="sent", provider_id=mid)
            return {"transport": "whatsapp", "status": "sent", "message_id": mid}
        if self.fallback == "log":
            await self._record(ctx, approval_id, channel="whatsapp", recipient=to, subject=None, body=body,
                               transport="log", status="logged")
            return {"transport": "log", "status": "logged"}
        raise MessagingError("no WhatsApp connector for this venture (connect WhatsApp in Settings)")
