"""Exotel: Indian business numbers (ExoPhones, 140/160-series and landlines) for AI phone calls.

Kritvia talks to callers over Exotel's Voicebot applet: Exotel opens a WebSocket to Kritvia and sends
the caller's audio (16-bit PCM, 8 or 16 kHz, base64 in JSON "media" messages); Kritvia sends its voice
back the same way, with "mark" and "clear" for turn-taking (services/voice_stream.py).

  inbound   the business's Exotel flow: ExoPhone -> Voicebot applet (the wss URL Kritvia shows once)
            -> Hangup applet
  outbound  POST /v1/Accounts/<sid>/Calls/connect with StreamUrl (bidirectional): Exotel calls the
            customer from the ExoPhone and streams the call to Kritvia when they answer
Auth: HTTP Basic with the account's API key and API token. Region: api.in.exotel.com (India, default)
or api.exotel.com (Singapore).
"""
from __future__ import annotations

from dataclasses import dataclass

import httpx

SUBDOMAINS = ("api.in.exotel.com", "api.exotel.com")


class ExotelError(Exception):
    pass


@dataclass
class Account:
    api_key: str
    api_token: str
    sid: str
    subdomain: str = "api.in.exotel.com"

    @property
    def base(self) -> str:
        sub = self.subdomain if self.subdomain in SUBDOMAINS else SUBDOMAINS[0]
        return f"https://{sub}/v1/Accounts/{self.sid}"


class ExotelClient:
    def __init__(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._transport = transport

    async def _call(self, a: Account, method: str, path: str, **kw) -> httpx.Response:
        try:
            async with httpx.AsyncClient(auth=(a.api_key, a.api_token), timeout=20, transport=self._transport) as h:
                r = await h.request(method, a.base + path, **kw)
        except httpx.HTTPError as exc:
            raise ExotelError(f"Exotel didn't answer ({type(exc).__name__})") from None
        if r.status_code in (401, 403):
            raise ExotelError("Exotel didn't accept the API key, token and account SID")
        return r

    async def check(self, a: Account) -> None:
        """The key, token and SID work (one call-list read)."""
        r = await self._call(a, "GET", "/Calls.json", params={"PageSize": 1})
        if r.status_code >= 500:
            raise ExotelError(f"Exotel had a problem (HTTP {r.status_code}); try again in a minute")

    async def place_call(self, a: Account, *, to: str, caller_id: str, stream_url: str, status_url: str,
                         custom: str) -> str:
        r = await self._call(a, "POST", "/Calls/connect.json", data={
            "From": to, "CallerId": caller_id, "StreamUrl": stream_url, "StreamType": "bidirectional",
            "StatusCallback": status_url, "StatusCallbackEvents[]": "terminal", "CustomField": custom[:128],
            "TimeLimit": "1800"})
        if r.status_code >= 400:
            try:
                msg = r.json()
                msg = ((msg.get("RestException") or {}).get("Message")) or msg
            except ValueError:
                msg = r.text
            raise ExotelError(f"Exotel said: {str(msg)[:200]}")
        try:
            return str(r.json()["Call"]["Sid"])
        except (ValueError, KeyError, TypeError):
            raise ExotelError("Exotel's answer had no call id") from None
