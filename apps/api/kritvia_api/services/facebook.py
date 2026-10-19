"""The business's Facebook Page: posts go to its feed after a yes.

The owner connects the Page with its Page access token (Meta Business Suite → Settings → the app's token, or
Graph API Explorer with pages_manage_posts). Kritvia checks the token on the Page, keeps it encrypted, and
never shows it again. Graph API calls only; nothing else on the Page is read.
"""
from __future__ import annotations

import re
import uuid

import httpx
from sqlalchemy import text

from kritvia_api.services.crypto import EnvelopeCrypto

GRAPH = "https://graph.facebook.com/v21.0"
SECRET = "connector.secret"
PAGE_ID = re.compile(r"^[0-9]{5,30}$")

_transport: httpx.AsyncBaseTransport | None = None     # tests


class FacebookError(Exception):
    pass


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=15.0, transport=_transport)


def _error(r: httpx.Response) -> str:
    try:
        e = r.json().get("error") or {}
        msg = str(e.get("message") or "")[:200]
    except ValueError:
        msg = ""
    return f"Facebook said: {msg}" if msg else f"Facebook answered HTTP {r.status_code}"


async def check_page(page_id: str, token: str) -> str:
    """The Page's name, if this token can post to it."""
    if not PAGE_ID.fullmatch(page_id or ""):
        raise FacebookError("the Page ID is the number in the Page's About → Page transparency (digits only)")
    async with _client() as http:
        r = await http.get(f"{GRAPH}/{page_id}", params={"fields": "name", "access_token": token})
    if r.status_code != 200:
        raise FacebookError(_error(r))
    return str(r.json().get("name") or "Facebook Page")[:160]


async def page(services, conn, venture_id: uuid.UUID) -> tuple[str, str] | None:
    """(page id, token) for the business's connected Page, or None."""
    c = (await conn.execute(text(
        "SELECT c.external_id, t.secret_enc FROM connectors c JOIN connector_tokens t ON t.connector_id = c.id"
        " WHERE c.venture_id = :v AND c.provider = 'facebook_page' AND c.status = 'active'"),
        {"v": venture_id})).first()
    if c is None:
        return None
    token = await EnvelopeCrypto(conn, services.keys).decrypt_str(venture_id, SECRET, c.secret_enc)
    return (c.external_id, token) if token else None


async def post(page_id: str, token: str, message: str) -> str:
    """Posts to the Page's feed; returns the post id."""
    async with _client() as http:
        r = await http.post(f"{GRAPH}/{page_id}/feed", data={"message": message, "access_token": token})
    if r.status_code != 200:
        raise FacebookError(_error(r))
    return str(r.json().get("id") or "")
