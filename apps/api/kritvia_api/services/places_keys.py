"""Whose Google Maps key a business's lookups run on.

Google bills Places API calls per call. A business's lookups run on its organisation's own key
(Settings -> AI models -> Google Maps key), so Google bills the customer, mostly inside Google's
free monthly calls. Kritvia's server key (GOOGLE_PLACES_API_KEY) is used only for internal
organisations (Sitelytc's own businesses).

Keys are stored like AI keys (services/byok.py): wrapped by the master key with the organisation
and service as associated data, never readable by the app role, never sent to the browser.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import text

from kritvia_api.services.crypto import KeyProvider
from kritvia_api.services.places import PlacesClient

SERVICE = "google_places"
SERVER_KEY_PLANS = frozenset({"internal"})
NO_KEY = ("add your Google Maps key in Settings → AI models so Kritvia can use Google Maps (Prospector, reviews) "
          "(Google bills these lookups to your own Google Cloud account, mostly inside its free monthly calls)")


def _context(org_id: uuid.UUID) -> bytes:
    return f"kritvia-service|{org_id}|{SERVICE}".encode()


def wrap(keys: KeyProvider, org_id: uuid.UUID, api_key: str) -> bytes:
    return keys.wrap(api_key.encode(), _context(org_id))


def unwrap(keys: KeyProvider, org_id: uuid.UUID, wrapped: bytes) -> str:
    return keys.unwrap(bytes(wrapped), _context(org_id)).decode()


def hint(api_key: str) -> str:
    return "…" + api_key.strip()[-4:]


@dataclass(frozen=True)
class PlacesAccess:
    client: PlacesClient | None
    org_id: uuid.UUID | None
    own_key: bool
    problem: str | None = None     # why there is no client, in words the owner can act on


async def places_for(conn, services, venture_id: uuid.UUID) -> PlacesAccess:
    """The Places client this venture's lookups must use, or why there is none."""
    server: PlacesClient | None = getattr(services, "places", None)
    row = (await conn.execute(text("SELECT org_id, key_wrapped FROM private.service_key_for(:v, :s)"),
                              {"v": venture_id, "s": SERVICE})).first()
    if row is None:
        return PlacesAccess(None, None, False, "business not found")
    if row.key_wrapped is not None:
        api_key = unwrap(services.keys, row.org_id, row.key_wrapped)
        transport = getattr(server, "_transport", None)   # tests inject a fake Google
        return PlacesAccess(PlacesClient(api_key, transport=transport), row.org_id, True)
    from kritvia_api.services.quota import plan_for_venture
    if server is not None and server.configured and (await plan_for_venture(conn, venture_id)).code in SERVER_KEY_PLANS:
        return PlacesAccess(server, row.org_id, False)
    return PlacesAccess(None, row.org_id, False, NO_KEY)


async def record(conn, access: PlacesAccess, error: str | None) -> None:
    """Shows the owner when Google rejects their key (and clears it once a call works)."""
    if access.own_key and access.org_id is not None:
        await conn.execute(text("SELECT private.service_key_result(:o, :s, :e)"),
                           {"o": access.org_id, "s": SERVICE, "e": error})


def key_problem(error: str) -> bool:
    """A Places error that means the key itself is wrong (not a passing outage)."""
    return any(code in error for code in ("returned 400", "returned 401", "returned 403"))
