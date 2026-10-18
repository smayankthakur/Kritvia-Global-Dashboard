"""Twilio Programmable Voice for a business's own number: request signatures, TwiML, and the REST calls
Kritvia makes (check the account and number, point the number's webhooks at Kritvia, place a call).

Calls are turn by turn: Twilio says Kritvia's words (Amazon Polly voices that speak Hindi and Indian
English) and listens with its own speech recognition (<Gather input="speech">), then posts what the
caller said to the turn webhook, which answers with the next TwiML. No audio passes through Kritvia.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import re
from dataclasses import dataclass
from typing import Any
from xml.sax.saxutils import escape, quoteattr

import httpx

API = "https://api.twilio.com/2010-04-01"
SID_RE = re.compile(r"^AC[0-9a-f]{32}$")
PHONE_RE = re.compile(r"^\+[1-9][0-9]{7,14}$")


class TwilioError(Exception):
    pass


def signature(auth_token: str, url: str, params: dict[str, str]) -> str:
    """Twilio's X-Twilio-Signature: base64(HMAC-SHA1(token, url + every POST field name and value, sorted by
    name)). `url` is exactly the address Twilio called, query string included."""
    data = url + "".join(f"{k}{params[k]}" for k in sorted(params))
    mac = hmac.new(auth_token.encode(), data.encode(), hashlib.sha1).digest()
    return base64.b64encode(mac).decode()


def valid(auth_token: str, url: str, params: dict[str, str], given: str | None) -> bool:
    if not given or not auth_token:
        return False
    return hmac.compare_digest(signature(auth_token, url, params), given)


def normalise_phone(raw: str, default_cc: str = "91") -> str | None:
    """'+91 98110 00011', '098110 00011', '9811000011' -> '+919811000011'. None if it isn't a number."""
    digits = re.sub(r"\D", "", raw or "")
    if (raw or "").strip().startswith("+"):
        p = "+" + digits
    elif len(digits) == 10:
        p = f"+{default_cc}{digits}"
    elif len(digits) == 11 and digits.startswith("0"):
        p = f"+{default_cc}{digits[1:]}"
    elif len(digits) == 12 and digits.startswith(default_cc):
        p = "+" + digits
    else:
        return None
    return p if PHONE_RE.match(p) else None


def mask(phone: str) -> str:
    """'+919811000011' -> '+91 98•••••011' for screens and push messages."""
    d = re.sub(r"\D", "", phone or "")
    if len(d) < 8:
        return "•••"
    return f"+{d[:-10]} {d[-10:-8]}•••••{d[-3:]}" if len(d) > 10 else f"{d[:2]}•••••{d[-3:]}"


# ---------------------------------------------------------------------------------------------- TwiML --
@dataclass(frozen=True)
class Voice:
    language: str = "hi-IN"         # Gather's recognition language and Say's language
    voice: str = "Polly.Aditi"      # speaks Hindi and Indian English


def _say(text: str, v: Voice) -> str:
    return f"<Say voice={quoteattr(v.voice)} language={quoteattr(v.language)}>{escape(text)}</Say>"


def listen(say: str, action: str, v: Voice, *, hints: list[str] | None = None, timeout_s: int = 6) -> str:
    """Say something, then listen for the caller's answer (speech, or a key: 0 = a person)."""
    hint = f" hints={quoteattr(', '.join(h[:40] for h in (hints or [])[:30]))}" if hints else ""
    return ("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response>"
            f"<Gather input=\"speech dtmf\" numDigits=\"1\" action={quoteattr(action)} method=\"POST\""
            f" language={quoteattr(v.language)} speechTimeout=\"auto\" timeout=\"{timeout_s}\""
            f" actionOnEmptyResult=\"true\" profanityFilter=\"false\"{hint}>{_say(say, v)}</Gather>"
            "</Response>")


def goodbye(say: str, v: Voice) -> str:
    return f"<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response>{_say(say, v)}<Hangup/></Response>"


def transfer(say: str, number: str, v: Voice, *, caller_id: str | None = None, after: str | None = None) -> str:
    """Put the caller through to a person; if nobody answers in 25 s, `after` (a URL) takes over."""
    cid = f" callerId={quoteattr(caller_id)}" if caller_id else ""
    act = f" action={quoteattr(after)} method=\"POST\"" if after else ""
    return ("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response>"
            f"{_say(say, v)}<Dial timeout=\"25\"{cid}{act}><Number>{escape(number)}</Number></Dial></Response>")


def reject() -> str:
    return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response><Reject reason=\"busy\"/></Response>"


# ---------------------------------------------------------------------------------------------- REST --
class TwilioClient:
    def __init__(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._transport = transport

    def _http(self, sid: str, token: str) -> httpx.AsyncClient:
        return httpx.AsyncClient(base_url=f"{API}/Accounts/{sid}", auth=(sid, token), timeout=20,
                                 transport=self._transport)

    async def _call(self, sid: str, token: str, method: str, path: str, data: dict[str, Any] | None = None,
                    params: dict[str, Any] | None = None) -> dict:
        try:
            async with self._http(sid, token) as h:
                r = await h.request(method, path, data=data, params=params)
        except httpx.HTTPError as exc:
            raise TwilioError(f"Twilio didn't answer ({type(exc).__name__})") from None
        if r.status_code == 401:
            raise TwilioError("Twilio didn't accept the account SID and auth token")
        if r.status_code >= 400:
            try:
                msg = r.json().get("message") or r.text
            except ValueError:
                msg = r.text
            raise TwilioError(f"Twilio said: {str(msg)[:200]}")
        return r.json()

    async def number(self, sid: str, token: str, phone: str) -> dict:
        """The account's number (must be one it owns, with voice)."""
        out = await self._call(sid, token, "GET", "/IncomingPhoneNumbers.json", params={"PhoneNumber": phone})
        nums = out.get("incoming_phone_numbers") or []
        if not nums:
            raise TwilioError(f"{phone} isn't a number in this Twilio account")
        n = nums[0]
        if not (n.get("capabilities") or {}).get("voice"):
            raise TwilioError(f"{phone} can't take voice calls")
        return n

    async def point_number(self, sid: str, token: str, number_sid: str, voice_url: str, status_url: str) -> None:
        await self._call(sid, token, "POST", f"/IncomingPhoneNumbers/{number_sid}.json",
                         data={"VoiceUrl": voice_url, "VoiceMethod": "POST", "StatusCallback": status_url,
                               "StatusCallbackMethod": "POST"})

    async def place_call(self, sid: str, token: str, *, to: str, from_: str, url: str, status_url: str) -> str:
        out = await self._call(sid, token, "POST", "/Calls.json", data={
            "To": to, "From": from_, "Url": url, "Method": "POST", "StatusCallback": status_url,
            "StatusCallbackMethod": "POST", "StatusCallbackEvent": "completed", "Timeout": "30"})
        return str(out["sid"])
