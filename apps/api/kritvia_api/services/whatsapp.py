"""WhatsApp Business via Meta's Cloud API — plain REST over httpx, transport injectable.

A venture connects its WhatsApp Business number by pasting the phone number id and
a permanent access token from Meta Business Manager (Settings → Connectors). Meta
delivers every inbound message for the app to ONE webhook URL
(`/hooks/whatsapp`), identified by that phone number id; signatures are checked
with the app secret. Replies drafted by agents go out through `send_text`.

Meta only lets a business send free-form text within 24 hours of the customer's
last message; outside that window a pre-approved template is required, which
Kritvia reports as a send failure rather than guessing a template.
"""
from __future__ import annotations

import hashlib
import hmac
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import httpx
from sqlalchemy import text

if TYPE_CHECKING:
    from kritvia_api.engine.context import RunContext

GRAPH = "https://graph.facebook.com/v20.0"


class WhatsAppError(Exception):
    pass


@dataclass
class WhatsAppConn:
    id: uuid.UUID
    phone_number_id: str
    display: str | None
    access_token: str


async def load_whatsapp(ctx: RunContext, conn) -> WhatsAppConn | None:
    row = (await conn.execute(
        text("SELECT c.id, c.external_id, c.account_email, t.secret_enc FROM connectors c"
             " JOIN connector_tokens t ON t.connector_id = c.id"
             " WHERE c.venture_id = :v AND c.provider = 'whatsapp' AND c.status = 'active'"),
        {"v": ctx.venture_id})).first()
    if row is None:
        return None
    token = await ctx.crypto(conn).decrypt_str(ctx.venture_id, "connector.secret", row.secret_enc)
    return WhatsAppConn(row.id, row.external_id or "", row.account_email, token or "")


def verify_signature(app_secret: str, body: bytes, header: str | None) -> bool:
    """X-Hub-Signature-256: sha256=HMAC(app_secret, raw body)."""
    if not app_secret or not header or not header.startswith("sha256="):
        return False
    expected = hmac.new(app_secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header[7:])


@dataclass
class InboundMessage:
    phone_number_id: str
    message_id: str
    sender: str                  # E.164 digits, no plus
    sender_name: str | None
    text: str
    kind: str                    # text | image | document | audio | other


def parse_inbound(payload: dict[str, Any]) -> list[InboundMessage]:
    """Flatten a Cloud API webhook payload into messages (statuses are ignored)."""
    out: list[InboundMessage] = []
    for entry in payload.get("entry") or []:
        for change in entry.get("changes") or []:
            value = change.get("value") or {}
            pnid = str((value.get("metadata") or {}).get("phone_number_id") or "")
            names = {c.get("wa_id"): (c.get("profile") or {}).get("name") for c in value.get("contacts") or []}
            for m in value.get("messages") or []:
                kind = m.get("type") or "other"
                if kind == "text":
                    body = (m.get("text") or {}).get("body") or ""
                elif kind in ("image", "document", "audio", "video"):
                    body = ((m.get(kind) or {}).get("caption") or f"[{kind} attachment]")
                elif kind == "button":
                    body = (m.get("button") or {}).get("text") or ""
                elif kind == "interactive":
                    i = m.get("interactive") or {}
                    body = ((i.get("button_reply") or i.get("list_reply") or {}).get("title")) or ""
                else:
                    body = f"[{kind}]"
                sender = str(m.get("from") or "")
                if not sender or not m.get("id"):
                    continue
                out.append(InboundMessage(pnid, str(m["id"]), sender, names.get(sender), body[:20000], kind))
    return out


class WhatsAppClient:
    def __init__(self, app_secret: str = "", verify_token: str = "",
                 transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.app_secret, self.verify_token = app_secret, verify_token
        self._http = httpx.AsyncClient(transport=transport, timeout=30)

    @property
    def configured(self) -> bool:
        return bool(self.app_secret and self.verify_token)

    async def send_text(self, conn: WhatsAppConn, *, to: str, body: str) -> str:
        """Returns the provider message id. `to` is digits with country code (no plus)."""
        to = "".join(ch for ch in to if ch.isdigit())
        if not to:
            raise WhatsAppError("recipient phone number is missing")
        r = await self._http.post(f"{GRAPH}/{conn.phone_number_id}/messages",
                                  headers={"Authorization": f"Bearer {conn.access_token}"},
                                  json={"messaging_product": "whatsapp", "recipient_type": "individual", "to": to,
                                        "type": "text", "text": {"preview_url": False, "body": body[:4096]}})
        if r.status_code >= 400:
            try:
                err = r.json().get("error", {})
                msg = err.get("message") or r.text
                if err.get("code") == 131047 or "24 hours" in msg:
                    msg = "the customer last wrote more than 24 hours ago; WhatsApp needs an approved template"
            except (ValueError, AttributeError):
                msg = r.text
            raise WhatsAppError(f"WhatsApp send failed: {msg[:300]}")
        data = r.json()
        return str((data.get("messages") or [{}])[0].get("id") or "")

    async def check_number(self, phone_number_id: str, access_token: str) -> dict[str, Any]:
        """Validate a pasted phone number id + token by reading the number's profile."""
        r = await self._http.get(f"{GRAPH}/{phone_number_id}",
                                 params={"fields": "display_phone_number,verified_name,quality_rating"},
                                 headers={"Authorization": f"Bearer {access_token}"})
        if r.status_code >= 400:
            raise WhatsAppError("WhatsApp rejected the phone number id or token")
        return r.json()

    async def mark_read(self, conn: WhatsAppConn, message_id: str) -> None:
        try:
            await self._http.post(f"{GRAPH}/{conn.phone_number_id}/messages",
                                  headers={"Authorization": f"Bearer {conn.access_token}"},
                                  json={"messaging_product": "whatsapp", "status": "read", "message_id": message_id})
        except httpx.HTTPError:
            pass
