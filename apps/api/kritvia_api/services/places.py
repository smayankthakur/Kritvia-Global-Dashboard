"""Google Places API (New): find businesses the way someone searching Google Maps would.

Used by the Prospector agent. `search` is one Text Search page of up to 20 places per
call; `details` looks one place up by its ID. Field masks ask only for what is needed
(the mask decides what Google bills). The transport is injectable so tests never
reach Google.

Google Maps Platform terms: only the place ID may be stored. Everything else (name,
phone, address, rating…) is used in the moment and never written to the database;
callers fetch it again when they need it.

Websites: Maps often lists an Instagram page, a Swiggy/Zomato menu or a link-in-bio
page as a business's "website". `website_kind` tells those apart from a real site,
because a restaurant whose only web presence is a Swiggy page is exactly who the
Prospector is looking for.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import httpx

SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"
PLACE_URL = "https://places.googleapis.com/v1/places/{id}"
DETAIL_FIELDS = ",".join((
    "id", "displayName", "formattedAddress", "nationalPhoneNumber", "internationalPhoneNumber", "websiteUri",
    "rating", "userRatingCount", "businessStatus", "primaryTypeDisplayName", "googleMapsUri",
))
NAME_FIELDS = "id,displayName"   # the cheapest lookup: enough to label a row in a list
FIELDS = ",".join((
    "places.id", "places.displayName", "places.formattedAddress", "places.nationalPhoneNumber",
    "places.internationalPhoneNumber", "places.websiteUri", "places.rating", "places.userRatingCount",
    "places.businessStatus", "places.primaryTypeDisplayName", "places.googleMapsUri", "nextPageToken",
))

# Hosts that are a listing or a profile, not the business's own website.
SOCIAL = ("instagram.com", "facebook.com", "fb.com", "fb.me", "wa.me", "whatsapp.com", "twitter.com", "x.com",
          "youtube.com", "linktr.ee", "linkin.bio", "bio.link", "beacons.ai", "t.me", "linkedin.com")
LISTINGS = ("swiggy.com", "zomato.com", "zoma.to", "magicpin.in", "eazydiner.com", "dineout.co.in",
            "justdial.com", "tripadvisor.com", "tripadvisor.in", "sulekha.com", "indiamart.com",
            "google.com", "g.page", "business.site", "dotpe.in", "thrivenow.in", "petpooja.com")


class PlacesError(Exception):
    pass


@dataclass(frozen=True)
class Place:
    place_id: str
    name: str
    address: str | None
    phone: str | None              # international format when Google has it, e.g. +91 98737 78861
    website: str | None
    rating: float | None
    review_count: int | None
    status: str                    # OPERATIONAL, CLOSED_TEMPORARILY, CLOSED_PERMANENTLY
    category: str | None
    maps_url: str | None

    @property
    def website_kind(self) -> str:
        """'none', 'social' (Instagram, link-in-bio…), 'listing' (Swiggy, Zomato…) or 'own'."""
        return website_kind(self.website)


def website_kind(url: str | None) -> str:
    if not url or not url.strip():
        return "none"
    host = (urlparse(url if "://" in url else f"https://{url}").hostname or "").lower()
    host = host.removeprefix("www.").removeprefix("m.")
    if any(host == h or host.endswith("." + h) for h in SOCIAL):
        return "social"
    if any(host == h or host.endswith("." + h) for h in LISTINGS):
        return "listing"
    return "own"


def _place(p: dict[str, Any]) -> Place:
    name = (p.get("displayName") or {}).get("text") or ""
    return Place(
        place_id=p.get("id") or "",
        name=name.strip(),
        address=p.get("formattedAddress"),
        phone=p.get("internationalPhoneNumber") or p.get("nationalPhoneNumber"),
        website=p.get("websiteUri"),
        rating=float(p["rating"]) if p.get("rating") is not None else None,
        review_count=int(p["userRatingCount"]) if p.get("userRatingCount") is not None else None,
        status=p.get("businessStatus") or "OPERATIONAL",
        category=(p.get("primaryTypeDisplayName") or {}).get("text"),
        maps_url=p.get("googleMapsUri"),
    )


class PlacesClient:
    def __init__(self, api_key: str, *, transport: httpx.AsyncBaseTransport | None = None,
                 timeout: float = 20.0) -> None:
        self.api_key = api_key
        self._transport, self._timeout = transport, timeout

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    async def details(self, place_id: str, *, name_only: bool = False, language: str = "en") -> Place:
        """One place by ID, live. Raises PlacesError (including when Google no longer knows the place)."""
        if not self.configured:
            raise PlacesError("the Google Places API key is not set (GOOGLE_PLACES_API_KEY)")
        if not place_id or "/" in place_id or len(place_id) > 300:
            raise PlacesError("invalid place id")
        async with httpx.AsyncClient(transport=self._transport, timeout=self._timeout) as client:
            try:
                r = await client.get(PLACE_URL.format(id=place_id), params={"languageCode": language}, headers={
                    "X-Goog-Api-Key": self.api_key, "X-Goog-FieldMask": NAME_FIELDS if name_only else DETAIL_FIELDS})
            except httpx.TransportError as exc:
                raise PlacesError(f"could not reach Google Places ({type(exc).__name__})") from exc
        if r.status_code != 200:
            msg = ""
            try:
                msg = (r.json().get("error") or {}).get("message", "")
            except ValueError:
                pass
            raise PlacesError(f"Google Places returned {r.status_code}: {msg[:200]}")
        return _place(r.json())

    async def search(self, query: str, *, max_results: int = 60, region: str = "IN",
                     language: str = "en") -> list[Place]:
        """Text Search, following next-page tokens until `max_results` places (Google stops at 60)."""
        if not self.configured:
            raise PlacesError("the Google Places API key is not set (GOOGLE_PLACES_API_KEY)")
        out: list[Place] = []
        token: str | None = None
        async with httpx.AsyncClient(transport=self._transport, timeout=self._timeout) as client:
            while len(out) < max_results:
                body: dict[str, Any] = {"textQuery": query[:300], "pageSize": min(20, max_results - len(out)),
                                        "regionCode": region, "languageCode": language}
                if token:
                    body["pageToken"] = token
                try:
                    r = await client.post(SEARCH_URL, json=body, headers={
                        "X-Goog-Api-Key": self.api_key, "X-Goog-FieldMask": FIELDS})
                except httpx.TransportError as exc:
                    raise PlacesError(f"could not reach Google Places ({type(exc).__name__})") from exc
                if r.status_code != 200:
                    msg = ""
                    try:
                        msg = (r.json().get("error") or {}).get("message", "")
                    except ValueError:
                        pass
                    raise PlacesError(f"Google Places returned {r.status_code}: {msg[:200]}")
                data = r.json()
                out.extend(_place(p) for p in data.get("places") or [] if p.get("id"))
                token = data.get("nextPageToken")
                if not token:
                    break
        return out[:max_results]


__all__ = ["Place", "PlacesClient", "PlacesError", "website_kind"]
