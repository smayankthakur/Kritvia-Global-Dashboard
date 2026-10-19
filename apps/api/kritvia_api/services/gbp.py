"""The business's Google Business Profile, through its own Google connection (scope business.manage):
review replies and 'What's new' updates are posted to Google after a yes.

Google must approve the Google Cloud project for the Business Profile APIs once (Google's access request);
until then every call answers 403 and Kritvia falls back to drafts a person copies into Google.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import text

from kritvia_api.services.crypto import EnvelopeCrypto
from kritvia_api.services.google import SCOPES


@dataclass
class Profile:
    token: str
    location: str | None          # accounts/N/locations/M, when the business chose its listing
    title: str | None


class NotConnected(Exception):
    """Google isn't connected with Business Profile access (the message says what to do)."""


async def connection(conn, venture_id: uuid.UUID):
    return (await conn.execute(text(
        "SELECT c.id, c.scopes, t.secret_enc FROM connectors c JOIN connector_tokens t ON t.connector_id = c.id"
        " WHERE c.venture_id = :v AND c.provider = 'google' AND c.status = 'active'"), {"v": venture_id})).first()


async def has_access(conn, venture_id: uuid.UUID) -> bool:
    c = await connection(conn, venture_id)
    return bool(c and SCOPES["business.manage"] in (c.scopes or []))


async def profile(services, conn, venture_id: uuid.UUID) -> Profile:
    google = getattr(services, "google", None)
    if google is None or not google.configured:
        raise NotConnected("Google isn't set up on this server")
    c = await connection(conn, venture_id)
    if c is None:
        raise NotConnected("connect Google in Settings first")
    if SCOPES["business.manage"] not in (c.scopes or []):
        raise NotConnected("reconnect Google with 'Business Profile' ticked (Reviews page) so Kritvia can post there")
    refresh = await EnvelopeCrypto(conn, services.keys).decrypt_str(venture_id, "connector.secret", c.secret_enc)
    token = await google.access_token(c.id, refresh or "")
    s = (await conn.execute(text("SELECT gbp_location, gbp_title FROM review_settings WHERE venture_id = :v"),
                            {"v": venture_id})).first()
    return Profile(token=token, location=s.gbp_location if s else None, title=s.gbp_title if s else None)
