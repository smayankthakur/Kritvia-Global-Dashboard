"""Campaigns: one message to many customers, with one yes for the whole send.

Who can be in one:

  WhatsApp  only people who agreed to hear from the business (they wrote first, or the team confirmed it),
            never anyone who wrote STOP, and always as one of the business's WhatsApp-approved templates:
              opted_in          everyone who agreed
              customers         those of them who are customers (an invoice or a booking)
              recent_customers  customers of the last 90 days
  Email     customers only (an invoice, a booking or a won lead with an email), never anyone who
            unsubscribed; every email carries a one-click unsubscribe link.
              customers / recent_customers

The list is fixed when the campaign asks for its yes: the approval says how many people, and exactly those
are sent to, in batches. At most MAX_RECIPIENTS per campaign.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import uuid

from sqlalchemy import text

from kritvia_api.config import get_settings

MAX_RECIPIENTS = 2000
BATCH = 40


def _mac(venture_id: uuid.UUID, address: str) -> bytes:
    key = get_settings().jwt_secret.encode()
    return hmac.new(key, b"campaign-optout:" + venture_id.bytes + address.lower().encode(), hashlib.sha256).digest()[:12]


def unsubscribe_token(venture_id: uuid.UUID, address: str) -> str:
    raw = venture_id.bytes + _mac(venture_id, address) + address.lower().encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def verify(token: str) -> tuple[uuid.UUID, str] | None:
    try:
        raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))
        v, mac, addr = uuid.UUID(bytes=raw[:16]), raw[16:28], raw[28:].decode()
    except (ValueError, TypeError, UnicodeDecodeError):
        return None
    if not addr or "@" not in addr or not hmac.compare_digest(mac, _mac(v, addr)):
        return None
    return v, addr


def unsubscribe_url(venture_id: uuid.UUID, address: str) -> str:
    return (f"{get_settings().public_web_url.rstrip('/')}/unsubscribe/campaign?t="
            f"{unsubscribe_token(venture_id, address)}")


WA_AUDIENCE = {
    "opted_in": "true",
    "customers": ("(EXISTS (SELECT 1 FROM invoices i WHERE i.venture_id = c.venture_id AND i.customer_phone = c.phone"
                  " AND i.status IN ('open', 'paid')) OR EXISTS (SELECT 1 FROM bookings b WHERE b.venture_id ="
                  " c.venture_id AND b.channel = 'whatsapp' AND b.address = c.phone AND b.status IN ('confirmed', 'done')))"),
    "recent_customers": ("(EXISTS (SELECT 1 FROM invoices i WHERE i.venture_id = c.venture_id AND i.customer_phone ="
                         " c.phone AND i.status IN ('open', 'paid') AND i.created_at > now() - interval '90 days')"
                         " OR EXISTS (SELECT 1 FROM bookings b WHERE b.venture_id = c.venture_id AND b.channel ="
                         " 'whatsapp' AND b.address = c.phone AND b.status IN ('confirmed', 'done')"
                         " AND b.starts_at > now() - interval '90 days'))"),
}


async def audience(conn, venture_id: uuid.UUID, channel: str, kind: str, limit: int = MAX_RECIPIENTS + 1
                   ) -> list[tuple[str, str | None]]:
    """[(address, name)] for a campaign, best known name first."""
    if channel == "whatsapp":
        where = WA_AUDIENCE[kind]
        rows = (await conn.execute(text(
            "SELECT c.phone AS address, c.name FROM wa_contacts c WHERE c.venture_id = :v"
            " AND c.opted_in_at IS NOT NULL AND c.opted_out_at IS NULL AND c.channel = 'whatsapp'"
            f" AND {where} ORDER BY c.last_inbound_at DESC NULLS LAST LIMIT :n"), {"v": venture_id, "n": limit})).all()
        return [(r.address, r.name) for r in rows]
    if kind not in ("customers", "recent_customers"):
        raise ValueError("an email campaign goes to customers")
    since = "now() - interval '90 days'" if kind == "recent_customers" else "'-infinity'::timestamptz"
    rows = (await conn.execute(text(
        "SELECT lower(address) AS address, max(name) AS name FROM ("
        f"  SELECT customer_email AS address, customer_name AS name FROM invoices WHERE venture_id = :v"
        f"   AND customer_email IS NOT NULL AND status IN ('open', 'paid') AND created_at > {since}"
        f"  UNION ALL SELECT address, customer_name FROM bookings WHERE venture_id = :v AND channel = 'email'"
        f"   AND status IN ('confirmed', 'done') AND starts_at > {since}"
        f"  UNION ALL SELECT email, name FROM leads WHERE venture_id = :v AND status = 'won' AND email IS NOT NULL"
        f"   AND created_at > {since}) x"
        " WHERE address LIKE '%@%' AND NOT EXISTS (SELECT 1 FROM email_optouts o WHERE o.venture_id = :v"
        "  AND o.address = lower(x.address))"
        " GROUP BY lower(address) ORDER BY lower(address) LIMIT :n"), {"v": venture_id, "n": limit})).all()
    return [(r.address, r.name) for r in rows]
