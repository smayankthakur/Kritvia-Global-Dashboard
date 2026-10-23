"""WhatsApp Business via Meta's Cloud API — plain REST over httpx, transport injectable.

A venture connects its WhatsApp Business number by pasting the phone number id and
a permanent access token from Meta Business Manager (Settings → Connectors). Meta
delivers every inbound message for the app to ONE webhook URL
(`/hooks/whatsapp`), identified by that phone number id; signatures are checked
with the app secret. Replies drafted by agents go out through `send_text`.

Meta only lets a business send free-form text within 24 hours of the customer's
last message; outside that window (or to write first) the business sends a message
template Meta approved (`send_template`). Templates are written in Kritvia or in
WhatsApp Manager and mirrored per business (`list_templates`, wa_templates).
"""
from __future__ import annotations

import hashlib
import hmac
import re
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

import httpx
from sqlalchemy import text

if TYPE_CHECKING:
    from kritvia_api.engine.context import RunContext

GRAPH_VERSION = "v25.0"
GRAPH = f"https://graph.facebook.com/{GRAPH_VERSION}"
META_FILE_HOSTS = (".fbsbx.com", ".facebook.com", ".whatsapp.net", ".fbcdn.net")


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
    kind: str                    # text | image | document | audio | interactive | other
    reply_id: str | None = None  # the id of a reply button pressed (interactive messages)
    media_id: str | None = None  # an audio message / voice note, for the owner's front door


def _body(m: dict[str, Any]) -> tuple[str, str]:
    """(text, kind) of one message object, inbound or echoed."""
    kind = m.get("type") or "other"
    if kind == "text":
        body = (m.get("text") or {}).get("body") or ""
    elif kind in ("image", "document", "audio", "video", "sticker"):
        body = ((m.get(kind) or {}).get("caption") or f"[{kind} attachment]")
    elif kind == "button":
        body = (m.get("button") or {}).get("text") or ""
    elif kind == "interactive":
        i = m.get("interactive") or {}
        body = ((i.get("button_reply") or i.get("list_reply") or {}).get("title")) or ""
    elif kind == "template":
        body = "[template message]"
    else:
        body = f"[{kind}]"
    return body[:20000], kind


def parse_inbound(payload: dict[str, Any]) -> list[InboundMessage]:
    """Flatten a Cloud API webhook payload into messages (statuses are ignored)."""
    out: list[InboundMessage] = []
    for entry in payload.get("entry") or []:
        for change in entry.get("changes") or []:
            value = change.get("value") or {}
            pnid = str((value.get("metadata") or {}).get("phone_number_id") or "")
            names = {c.get("wa_id"): (c.get("profile") or {}).get("name") for c in value.get("contacts") or []}
            for m in value.get("messages") or []:
                body, kind = _body(m)
                sender = str(m.get("from") or "")
                if not sender or not m.get("id"):
                    continue
                i = m.get("interactive") or {}
                reply = (i.get("button_reply") or i.get("list_reply") or {}) if kind == "interactive" else {}
                reply_id = str(reply.get("id"))[:256] if reply.get("id") else None
                media = (m.get("audio") or {}) if kind == "audio" else {}
                media_id = str(media.get("id"))[:200] if media.get("id") else None
                out.append(InboundMessage(pnid, str(m["id"]), sender, names.get(sender), body, kind, reply_id, media_id))
    return out


@dataclass
class EchoMessage:
    """A message the business sent from the WhatsApp Business app on its phone (coexistence)."""
    phone_number_id: str
    message_id: str
    to: str                      # the customer, digits
    text: str
    kind: str


def parse_echoes(payload: dict[str, Any]) -> list[EchoMessage]:
    out: list[EchoMessage] = []
    for entry in payload.get("entry") or []:
        for change in entry.get("changes") or []:
            if change.get("field") not in (None, "smb_message_echoes"):
                continue
            value = change.get("value") or {}
            pnid = str((value.get("metadata") or {}).get("phone_number_id") or "")
            for m in value.get("message_echoes") or []:
                to = "".join(ch for ch in str(m.get("to") or "") if ch.isdigit())
                if not to or not m.get("id"):
                    continue
                body, kind = _body(m)
                out.append(EchoMessage(pnid, str(m["id"]), to, body, kind))
    return out


@dataclass
class TemplateStatus:
    waba_id: str
    meta_id: str
    name: str
    language: str
    status: str                  # APPROVED | REJECTED | PAUSED | DISABLED | ...
    reason: str | None


def parse_template_statuses(payload: dict[str, Any]) -> list[TemplateStatus]:
    out: list[TemplateStatus] = []
    for entry in payload.get("entry") or []:
        waba = str(entry.get("id") or "")
        for change in entry.get("changes") or []:
            if change.get("field") != "message_template_status_update":
                continue
            v = change.get("value") or {}
            if not waba or not v.get("event"):
                continue
            other = v.get("other_info") if isinstance(v.get("other_info"), dict) else {}
            reason = v.get("reason") or other.get("description")
            out.append(TemplateStatus(waba, str(v.get("message_template_id") or ""), str(v.get("message_template_name") or ""),
                                      str(v.get("message_template_language") or ""), str(v["event"]).upper()[:30],
                                      (str(reason)[:300] if reason and str(reason).upper() != "NONE" else None)))
    return out


# --- Templates --------------------------------------------------------------------------------
PARAM = re.compile(r"\{\{\s*(\d+)\s*\}\}")


def template_params(body: str) -> int:
    """Number of blanks ({{1}}, {{2}}, …) in a template body."""
    nums = {int(n) for n in PARAM.findall(body or "")}
    return max(nums) if nums else 0


def check_template_body(body: str) -> str | None:
    """Meta's rules for a body, checked before sending it for review. None when fine."""
    b = (body or "").strip()
    if not b:
        return "write the message"
    if len(b) > 1024:
        return "keep the message under 1024 characters"
    nums = [int(n) for n in PARAM.findall(b)]
    if nums and sorted(set(nums)) != list(range(1, max(nums) + 1)):
        return "number the blanks in order: {{1}}, {{2}}, {{3}}"
    if PARAM.match(b) or re.search(r"\{\{\s*\d+\s*\}\}[.!?\s]*$", b):
        return "a message can't start or end with a blank; add a few words around it"
    if re.search(r"\{\{[^}]*\}\}", PARAM.sub("", b)):
        return "blanks are written {{1}}, {{2}} … with numbers only"
    if nums and len(re.findall(r"\w+", PARAM.sub("", b))) < 2 * len(nums) + 1:
        return "add more words around the blanks; WhatsApp rejects messages that are mostly blanks"
    return None


def check_param(value: str) -> str | None:
    v = value or ""
    if not v.strip():
        return "fill in every blank"
    if "\n" in v or "\t" in v or "    " in v:
        return "a blank can't contain new lines, tabs or more than three spaces in a row"
    if len(v) > 300:
        return "keep each blank under 300 characters"
    return None


def render_template(body: str, params: list[str]) -> str:
    """The text the customer sees, for the chat history."""
    return PARAM.sub(lambda m: params[int(m.group(1)) - 1] if 0 < int(m.group(1)) <= len(params) else m.group(0), body)


@dataclass
class MetaTemplate:
    meta_id: str
    name: str
    language: str
    category: str
    status: str
    body: str
    params: int
    examples: list[str]
    sendable: bool
    reason: str | None


def _from_meta(t: dict[str, Any]) -> MetaTemplate | None:
    body, examples, sendable = "", [], True
    for c in t.get("components") or []:
        typ = str(c.get("type") or "").upper()
        if typ == "BODY":
            body = str(c.get("text") or "")
            ex = ((c.get("example") or {}).get("body_text") or [[]])
            examples = [str(x) for x in (ex[0] if ex and isinstance(ex[0], list) else [])]
        elif typ == "HEADER":
            if str(c.get("format") or "TEXT").upper() != "TEXT" or PARAM.search(str(c.get("text") or "")):
                sendable = False
        elif typ == "BUTTONS":
            for b in c.get("buttons") or []:
                bt = str(b.get("type") or "").upper()
                if bt not in ("QUICK_REPLY", "URL", "PHONE_NUMBER") or PARAM.search(str(b.get("url") or "")):
                    sendable = False
        elif typ not in ("FOOTER",):
            sendable = False
    if not body or not t.get("name") or not t.get("language"):
        return None
    category = str(t.get("category") or "UTILITY").upper()
    if category not in ("MARKETING", "UTILITY", "AUTHENTICATION"):
        category = "UTILITY"
    if category == "AUTHENTICATION":
        sendable = False
    reason = t.get("rejected_reason")
    return MetaTemplate(str(t.get("id") or ""), str(t["name"]), str(t["language"]), category,
                        str(t.get("status") or "PENDING").upper()[:30], body[:1024], template_params(body),
                        examples[:20], sendable, (str(reason)[:300] if reason and str(reason).upper() != "NONE" else None))


def _meta_error(r: httpx.Response, fallback: str) -> str:
    try:
        err = r.json().get("error", {})
        msg = str(err.get("error_user_msg") or err.get("message") or "")
        code = err.get("code")
    except (ValueError, AttributeError):
        msg, code = "", None
    known = {
        131047: "the customer last wrote more than 24 hours ago; WhatsApp needs an approved template",
        131049: "WhatsApp held this message back to avoid sending this customer too many marketing messages; try a utility "
                "template or wait a few days",
        131050: "this customer has turned off marketing messages from businesses",
        131026: "WhatsApp could not deliver to this number (it may not be on WhatsApp)",
        132000: "the number of filled-in blanks doesn't match the template",
        132001: "this template doesn't exist on WhatsApp (yet); refresh the templates",
        132007: "WhatsApp rejected this template's wording",
        132015: "this template is paused because customers reported or blocked it; edit it in WhatsApp Manager",
        132016: "this template has been switched off by WhatsApp",
        100: msg or fallback,
    }
    if code in known:
        return known[code][:300]
    if "already exists" in msg.lower():
        return "a template with this name and language already exists; pick another name"
    return (msg or fallback)[:300]


UNREACHABLE = "couldn't reach WhatsApp; try again in a minute"


class _Graph:
    """The HTTP client for Meta's Graph API. A network failure (timeout, reset, DNS) becomes a
    WhatsAppError, so every caller's `except WhatsAppError` records the failure instead of a 500."""

    def __init__(self, client: httpx.AsyncClient) -> None:
        self.client = client

    async def request(self, method: str, url: str, **kw: Any) -> httpx.Response:
        try:
            return await self.client.request(method, url, **kw)
        except httpx.HTTPError:
            raise WhatsAppError(UNREACHABLE) from None

    async def get(self, url: str, **kw: Any) -> httpx.Response:
        return await self.request("GET", url, **kw)

    async def post(self, url: str, **kw: Any) -> httpx.Response:
        return await self.request("POST", url, **kw)

    async def delete(self, url: str, **kw: Any) -> httpx.Response:
        return await self.request("DELETE", url, **kw)

    def stream(self, method: str, url: str, **kw: Any):
        return self.client.stream(method, url, **kw)


class WhatsAppClient:
    def __init__(self, app_secret: str = "", verify_token: str = "",
                 transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.app_secret, self.verify_token = app_secret, verify_token
        self._http = _Graph(httpx.AsyncClient(transport=transport, timeout=30))

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

    async def send_template(self, conn: WhatsAppConn, *, to: str, name: str, language: str,
                            params: list[str]) -> str:
        """Sends an approved template; allowed at any time (first message, or after 24 hours)."""
        to = "".join(ch for ch in to if ch.isdigit())
        if not to:
            raise WhatsAppError("recipient phone number is missing")
        tpl: dict[str, Any] = {"name": name, "language": {"code": language}}
        if params:
            tpl["components"] = [{"type": "body", "parameters": [{"type": "text", "text": p} for p in params]}]
        r = await self._http.post(f"{GRAPH}/{conn.phone_number_id}/messages",
                                  headers={"Authorization": f"Bearer {conn.access_token}"},
                                  json={"messaging_product": "whatsapp", "recipient_type": "individual", "to": to,
                                        "type": "template", "template": tpl})
        if r.status_code >= 400:
            raise WhatsAppError(f"WhatsApp send failed: {_meta_error(r, 'WhatsApp refused the message')}")
        return str((r.json().get("messages") or [{}])[0].get("id") or "")

    async def list_templates(self, waba_id: str, token: str) -> list[MetaTemplate]:
        """Every template on the business's WhatsApp account (follows Meta's pages, up to 500)."""
        out: list[MetaTemplate] = []
        url: str | None = f"{GRAPH}/{waba_id}/message_templates"
        params: dict[str, Any] | None = {"fields": "id,name,language,status,category,components,rejected_reason",
                                         "limit": 100}
        for _ in range(5):
            if not url:
                break
            r = await self._http.get(url, params=params, headers={"Authorization": f"Bearer {token}"})
            if r.status_code >= 400:
                raise WhatsAppError(f"could not read templates: {_meta_error(r, 'Meta refused')}")
            data = r.json()
            out += [t for t in (_from_meta(x) for x in data.get("data") or []) if t]
            nxt = (data.get("paging") or {}).get("next")
            url, params = (nxt, None) if nxt and str(nxt).startswith(GRAPH) else (None, None)
        return out

    async def create_template(self, waba_id: str, token: str, *, name: str, language: str, category: str,
                              body: str, examples: list[str]) -> tuple[str, str, str]:
        """Sends a template to Meta for review. Returns (meta id, status, category Meta settled on)."""
        comp: dict[str, Any] = {"type": "BODY", "text": body}
        if examples:
            comp["example"] = {"body_text": [examples]}
        r = await self._http.post(f"{GRAPH}/{waba_id}/message_templates", headers={"Authorization": f"Bearer {token}"},
                                  json={"name": name, "language": language, "category": category,
                                        "components": [comp]})
        if r.status_code >= 400:
            raise WhatsAppError(_meta_error(r, "Meta did not accept the template"))
        d = r.json()
        return str(d.get("id") or ""), str(d.get("status") or "PENDING").upper()[:30], \
            str(d.get("category") or category).upper()

    async def delete_template(self, waba_id: str, token: str, *, name: str, meta_id: str | None) -> None:
        params = {"name": name, **({"hsm_id": meta_id} if meta_id else {})}
        r = await self._http.delete(f"{GRAPH}/{waba_id}/message_templates", params=params,
                                    headers={"Authorization": f"Bearer {token}"})
        if r.status_code >= 400 and r.status_code != 404:
            raise WhatsAppError(_meta_error(r, "Meta did not delete the template"))

    async def number_ids(self, waba_id: str, token: str) -> list[str]:
        r = await self._http.get(f"{GRAPH}/{waba_id}/phone_numbers", headers={"Authorization": f"Bearer {token}"},
                                 params={"fields": "id"})
        return [str(n.get("id")) for n in (r.json().get("data") or [])] if r.status_code < 400 else []

    # --- Embedded Signup: "Connect WhatsApp" with a Facebook login, no tokens to copy ----------
    async def exchange_code(self, app_id: str, code: str) -> str:
        """The code Meta's signup popup returns (valid 30 seconds) → the business's token for our app."""
        r = await self._http.get(f"{GRAPH}/oauth/access_token",
                                 params={"client_id": app_id, "client_secret": self.app_secret, "code": code})
        if r.status_code >= 400:
            raise WhatsAppError("Meta did not accept the sign-in; please try connecting again")
        try:
            data = r.json()
            token = data.get("access_token") if isinstance(data, dict) else None
        except ValueError:
            token = r.text.strip()
        if not token:
            raise WhatsAppError("Meta did not return access for this business; please try connecting again")
        return str(token)

    async def subscribe_app(self, waba_id: str, token: str) -> None:
        """Messages for the customer's WhatsApp account come to our webhook from now on."""
        r = await self._http.post(f"{GRAPH}/{waba_id}/subscribed_apps", headers={"Authorization": f"Bearer {token}"})
        if r.status_code >= 400:
            raise WhatsAppError("could not switch on incoming messages for this WhatsApp account")

    async def first_number(self, waba_id: str, token: str) -> str:
        """The phone number id of a WhatsApp account, when the signup window did not name one."""
        ids = await self.number_ids(waba_id, token)
        if not ids:
            raise WhatsAppError("this WhatsApp account has no phone number yet; add one in the window and try again")
        return ids[0]

    async def register_number(self, phone_number_id: str, token: str, pin: str) -> None:
        """Puts a number added in the signup on the Cloud API. `pin` becomes its two-step verification PIN.
        A number that is already registered is fine."""
        r = await self._http.post(f"{GRAPH}/{phone_number_id}/register", headers={"Authorization": f"Bearer {token}"},
                                  json={"messaging_product": "whatsapp", "pin": pin})
        if r.status_code >= 400:
            try:
                msg = str((r.json().get("error") or {}).get("message") or "")
            except (ValueError, AttributeError):
                msg = ""
            if "already registered" not in msg.lower():
                raise WhatsAppError("could not activate this number on WhatsApp; check it in WhatsApp Manager and try again")

    async def check_number(self, phone_number_id: str, access_token: str) -> dict[str, Any]:
        """Validate a pasted phone number id + token by reading the number's profile."""
        r = await self._http.get(f"{GRAPH}/{phone_number_id}",
                                 params={"fields": "display_phone_number,verified_name,quality_rating"},
                                 headers={"Authorization": f"Bearer {access_token}"})
        if r.status_code >= 400:
            raise WhatsAppError("WhatsApp rejected the phone number id or token")
        return r.json()

    async def send_buttons(self, conn: WhatsAppConn, *, to: str, body: str, buttons: list[tuple[str, str]]) -> str:
        """A message with up to 3 reply buttons (id, title); allowed only inside the 24-hour window."""
        to = "".join(ch for ch in to if ch.isdigit())
        if not to:
            raise WhatsAppError("recipient phone number is missing")
        r = await self._http.post(f"{GRAPH}/{conn.phone_number_id}/messages",
                                  headers={"Authorization": f"Bearer {conn.access_token}"},
                                  json={"messaging_product": "whatsapp", "recipient_type": "individual", "to": to,
                                        "type": "interactive", "interactive": {
                                            "type": "button", "body": {"text": body[:1024]},
                                            "action": {"buttons": [{"type": "reply", "reply": {"id": i[:256], "title": t[:20]}}
                                                                   for i, t in buttons[:3]]}}})
        if r.status_code >= 400:
            raise WhatsAppError(f"WhatsApp send failed: {_meta_error(r, 'WhatsApp refused the message')}")
        return str((r.json().get("messages") or [{}])[0].get("id") or "")

    async def media(self, conn: WhatsAppConn, media_id: str, max_bytes: int = 10 * 1024 * 1024) -> tuple[bytes, str]:
        """A file someone sent (a voice note): its address from the Graph API, then the file, with the
        business's token. Returns (bytes, mime type)."""
        h = {"Authorization": f"Bearer {conn.access_token}"}
        try:
            r = await self._http.get(f"{GRAPH}/{media_id}", headers=h)
            info = r.json() if r.status_code == 200 else {}
            url, mime = str(info.get("url") or ""), str(info.get("mime_type") or "audio/ogg")
            host = (urlsplit(url).hostname or "").lower()
            # The business's token goes with the download, so only to Meta's own file hosts.
            if (not url.startswith("https://") or not host.endswith(META_FILE_HOSTS)
                    or int(info.get("file_size") or 0) > max_bytes):
                raise WhatsAppError("WhatsApp didn't give the file")
            data = bytearray()
            async with self._http.stream("GET", url, headers=h) as f:
                if f.status_code != 200:
                    raise WhatsAppError("WhatsApp didn't give the file")
                async for chunk in f.aiter_bytes():
                    data += chunk
                    if len(data) > max_bytes:
                        raise WhatsAppError("that file is too large")
        except (httpx.HTTPError, ValueError):
            raise WhatsAppError("couldn't reach WhatsApp") from None
        return bytes(data), mime

    async def mark_read(self, conn: WhatsAppConn, message_id: str) -> None:
        try:
            await self._http.post(f"{GRAPH}/{conn.phone_number_id}/messages",
                                  headers={"Authorization": f"Bearer {conn.access_token}"},
                                  json={"messaging_product": "whatsapp", "status": "read", "message_id": message_id})
        except WhatsAppError:
            pass
