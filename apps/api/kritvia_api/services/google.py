"""Google Workspace connector: OAuth (offline access), Gmail, Calendar, Drive.

Plain REST over httpx (no Google SDK) so the transport is injectable in tests.
Only plans listed in GOOGLE_READ_PLANS (default: internal) ask for the restricted read
scopes; everyone else gets SEND_ONLY_SCOPES, forwards mail to Kritvia instead, and picks
Drive files with Google's file picker (drive.file).
"""
from __future__ import annotations

import base64
import re
import time
import uuid
from dataclasses import dataclass
from email import policy as _email_policy
from email.message import EmailMessage
from email.utils import parseaddr
from typing import Any
from urllib.parse import urlencode

import httpx

from kritvia_api.services.auto_reply import automated_sender

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me"
CALENDAR = "https://www.googleapis.com/calendar/v3"
DRIVE = "https://www.googleapis.com/drive/v3"

SCOPES = {
    "gmail.readonly": "https://www.googleapis.com/auth/gmail.readonly",
    "gmail.send": "https://www.googleapis.com/auth/gmail.send",
    "calendar.events": "https://www.googleapis.com/auth/calendar.events",
    "drive.readonly": "https://www.googleapis.com/auth/drive.readonly",
    "drive.file": "https://www.googleapis.com/auth/drive.file",
    # Google Business Profile: post review replies and updates. Google must also approve the project for the
    # Business Profile APIs (a one-time access request).
    "business.manage": "https://www.googleapis.com/auth/business.manage",
}
GBP_ACCOUNTS = "https://mybusinessaccountmanagement.googleapis.com/v1/accounts"
GBP_INFO = "https://mybusinessbusinessinformation.googleapis.com/v1"
GBP_V4 = "https://mybusiness.googleapis.com/v4"
STARS = {"ONE": 1, "TWO": 2, "THREE": 3, "FOUR": 4, "FIVE": 5}
# Restricted scopes (gmail.readonly, drive.readonly) need Google's paid security assessment (CASA) past
# 100 users. Everyone else connects with these: send mail, calendar, and only the Drive files they pick.
# Their incoming mail arrives by forwarding (services/email_in.py).
SEND_ONLY_SCOPES = ["openid", "email", SCOPES["gmail.send"], SCOPES["calendar.events"], SCOPES["drive.file"]]
DEFAULT_SCOPES = ["openid", "email", SCOPES["gmail.readonly"], SCOPES["gmail.send"], SCOPES["calendar.events"],
                  SCOPES["drive.readonly"], SCOPES["drive.file"]]

LONG_HEADERS = _email_policy.default.clone(max_line_length=998)


class GoogleError(Exception):
    pass


@dataclass
class GmailMessage:
    id: str
    thread_id: str
    sender: str
    sender_email: str
    to: str
    subject: str
    date: str
    body: str
    attachments: list[dict[str, Any]]
    authenticated: bool = False   # Gmail's own check (its topmost header): the From domain passed DMARC or signed it
    automated: bool = False       # a machine sent it (no-reply, newsletter, auto-reply): never answered by itself




def _authserv(header: str) -> str:
    """The server that wrote an (ARC-)Authentication-Results header: 'mx.google.com', or for ARC's
    'i=1; mx.cloudflare.net; ...' the part after the instance number."""
    parts = [p.strip().lower() for p in header.split(";")]
    if parts and parts[0].startswith("i=") and len(parts) > 1:
        parts = parts[1:]
    return parts[0].split()[0] if parts and parts[0] else ""


def _aligned(domain: str, from_domain: str) -> bool:
    """DMARC's relaxed alignment, approximately: the same domain, or one a subdomain of the other."""
    d, f = domain.lower().strip(".@ "), from_domain.lower().strip(".@ ")
    return bool(d and f) and (d == f or d.endswith("." + f) or f.endswith("." + d))


def sender_authenticated(auth_results: list[str], from_email: str = "", authserv: str = "mx.google.com") -> bool:
    """True when Gmail's own Authentication-Results show the From domain really sent the message.

    Only the topmost header stamped by mx.google.com counts: Gmail adds its own above everything else, so
    a header a sender wrote into the message further down is ignored. The pass must be about the From
    domain: dmarc=pass for header.from=<that domain>, or a DKIM signature from that domain. SPF alone, or
    a DKIM pass for some other domain (a sender signing with their own domain while showing a bank in
    From), doesn't count."""
    from_domain = from_email.rpartition("@")[2].lower() if "@" in from_email else ""
    header = next((v for v in auth_results if _authserv(v) == authserv), None)
    if header is None or not from_domain:
        return False
    for kind, result, props in auth_clauses(header):
        if result != "pass":
            continue
        if kind == "dmarc":
            if _aligned(props.get("header.from", ""), from_domain):
                return True
        elif kind == "dkim":
            signer = props.get("header.d") or props.get("header.i", "").rpartition("@")[2]
            if _aligned(signer, from_domain):
                return True
    return False


_COMMENT = re.compile(r"\([^()]*\)")
_QUOTED = re.compile(r'"(?:[^"\\]|\\.)*"')
_RESULT = re.compile(r"^\s*([a-z][a-z0-9-]*)\s*=\s*([a-z]+)\b(.*)$", re.I | re.S)
_PROP = re.compile(r"([a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*)\s*=\s*([^\s;]+)", re.I)


def auth_clauses(header: str) -> list[tuple[str, str, dict[str, str]]]:
    """An Authentication-Results header (RFC 8601) as (method, result, properties) per clause. Comments
    "( … )" and quoted strings are removed first: the sender chooses what goes in them (the envelope address
    Gmail repeats in the SPF comment), so text such as "dkim=pass header.d=bank.in" inside them must never
    count (round 3, C4). Only each clause's leading method=result is read."""
    h = _QUOTED.sub(" ", header or "")
    for _ in range(5):                       # nested comments, innermost first
        h2 = _COMMENT.sub(" ", h)
        if h2 == h:
            break
        h = h2
    out = []
    for clause in h.split(";")[1:]:          # the first part names the server that wrote the header
        m = _RESULT.match(clause)
        if not m:
            continue
        props = {k.lower(): v.strip().lower() for k, v in _PROP.findall(m.group(3))}
        out.append((m.group(1).lower(), m.group(2).lower(), props))
    return out


class GoogleClient:
    def __init__(self, client_id: str, client_secret: str, redirect_uri: str,
                 transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.client_id, self.client_secret, self.redirect_uri = client_id, client_secret, redirect_uri
        self._http = httpx.AsyncClient(transport=transport, timeout=30)
        self._tokens: dict[uuid.UUID, tuple[str, float]] = {}

    @property
    def configured(self) -> bool:
        return bool(self.client_id and self.client_secret)

    async def aclose(self) -> None:
        await self._http.aclose()

    # --- OAuth ----------------------------------------------------------------
    def authorization_url(self, state: str, scopes: list[str] | None = None) -> str:
        return AUTH_URL + "?" + urlencode({
            "client_id": self.client_id, "redirect_uri": self.redirect_uri, "response_type": "code",
            "scope": " ".join(scopes or DEFAULT_SCOPES), "access_type": "offline",
            "prompt": "consent", "include_granted_scopes": "true", "state": state,
        })

    async def exchange_code(self, code: str) -> dict[str, Any]:
        r = await self._http.post(TOKEN_URL, data={
            "code": code, "client_id": self.client_id, "client_secret": self.client_secret,
            "redirect_uri": self.redirect_uri, "grant_type": "authorization_code"})
        if r.status_code != 200:
            raise GoogleError(f"token exchange failed: HTTP {r.status_code}")
        tok = r.json()
        if not tok.get("refresh_token"):
            raise GoogleError("Google returned no refresh token; revoke access and reconnect")
        info = await self._http.get(USERINFO_URL, headers={"Authorization": f"Bearer {tok['access_token']}"})
        email = info.json().get("email") if info.status_code == 200 else None
        return {"refresh_token": tok["refresh_token"], "scope": tok.get("scope", ""), "email": email}

    # --- Sign in with Google (identity only: no offline access, no Workspace scopes) ---
    def signin_url(self, state: str) -> str:
        return AUTH_URL + "?" + urlencode({
            "client_id": self.client_id, "redirect_uri": self.redirect_uri, "response_type": "code",
            "scope": "openid email profile", "state": state, "prompt": "select_account",
        })

    async def signin_identity(self, code: str) -> dict[str, Any]:
        """Exchanges a sign-in code for the Google account's id, verified email and name."""
        r = await self._http.post(TOKEN_URL, data={
            "code": code, "client_id": self.client_id, "client_secret": self.client_secret,
            "redirect_uri": self.redirect_uri, "grant_type": "authorization_code"})
        if r.status_code != 200:
            raise GoogleError(f"token exchange failed: HTTP {r.status_code}")
        info = await self._http.get(USERINFO_URL,
                                    headers={"Authorization": f"Bearer {r.json()['access_token']}"})
        if info.status_code != 200:
            raise GoogleError(f"could not read the Google profile: HTTP {info.status_code}")
        p = info.json()
        if not p.get("sub") or not p.get("email"):
            raise GoogleError("Google did not return an account id and email")
        if p.get("email_verified") is not True:
            raise GoogleError("this Google account's email address is not verified")
        return {"sub": str(p["sub"]), "email": str(p["email"]), "name": str(p.get("name") or "")}

    async def access_token(self, connector_id: uuid.UUID, refresh_token: str) -> str:
        cached = self._tokens.get(connector_id)
        if cached and cached[1] > time.time() + 60:
            return cached[0]
        r = await self._http.post(TOKEN_URL, data={
            "client_id": self.client_id, "client_secret": self.client_secret,
            "refresh_token": refresh_token, "grant_type": "refresh_token"})
        if r.status_code != 200:
            raise GoogleError(f"token refresh failed: HTTP {r.status_code} (reconnect Google)")
        tok = r.json()
        self._tokens[connector_id] = (tok["access_token"], time.time() + int(tok.get("expires_in", 3600)))
        return tok["access_token"]

    async def _req(self, method: str, url: str, token: str, **kw) -> dict[str, Any]:
        r = await self._http.request(method, url, headers={"Authorization": f"Bearer {token}"}, **kw)
        if r.status_code >= 400:
            raise GoogleError(f"{method} {url.split('?')[0]} -> HTTP {r.status_code}")
        return r.json() if r.content else {}

    # --- Google Business Profile ---------------------------------------------
    async def gbp_locations(self, token: str) -> list[dict[str, str]]:
        """The Business Profile locations this Google account manages: name 'accounts/N/locations/M', title."""
        out: list[dict[str, str]] = []
        accounts = (await self._req("GET", GBP_ACCOUNTS, token, params={"pageSize": 20})).get("accounts", [])
        for a in accounts[:20]:
            got = await self._req("GET", f"{GBP_INFO}/{a['name']}/locations", token,
                                  params={"readMask": "name,title,storefrontAddress", "pageSize": 100})
            for loc in got.get("locations", []):
                addr = loc.get("storefrontAddress") or {}
                lines = ", ".join([*addr.get("addressLines", []), addr.get("locality", "")]).strip(", ")
                out.append({"name": f"{a['name']}/{loc['name']}", "title": loc.get("title", ""), "address": lines})
        return out

    async def gbp_reviews(self, token: str, location: str) -> list[dict[str, Any]]:
        """The location's latest reviews: name, rating 1-5, reviewer, comment, and whether it has a reply."""
        got = await self._req("GET", f"{GBP_V4}/{location}/reviews", token, params={"pageSize": 50})
        out = []
        for r in got.get("reviews", []):
            out.append({"name": r.get("name", ""), "rating": STARS.get(r.get("starRating", ""), 0),
                        "author": (r.get("reviewer") or {}).get("displayName", "A customer"),
                        "text": r.get("comment", ""), "when": r.get("createTime", ""),
                        "replied": bool((r.get("reviewReply") or {}).get("comment"))})
        return out

    async def gbp_reply(self, token: str, review_name: str, comment: str) -> dict[str, Any]:
        return await self._req("PUT", f"{GBP_V4}/{review_name}/reply", token, json={"comment": comment})

    async def gbp_listing(self, token: str, location: str) -> dict[str, Any]:
        """The listing's title, opening hours, website and main phone (Business Information API)."""
        info = location[location.index("locations/"):]
        return await self._req("GET", f"{GBP_INFO}/{info}", token,
                               params={"readMask": "name,title,regularHours,websiteUri,phoneNumbers"})

    async def gbp_set_hours(self, token: str, location: str, periods: list[dict[str, Any]]) -> dict[str, Any]:
        """Replaces the listing's regular opening hours."""
        info = location[location.index("locations/"):]
        return await self._req("PATCH", f"{GBP_INFO}/{info}", token, params={"updateMask": "regularHours"},
                               json={"regularHours": {"periods": periods}})

    async def gbp_post(self, token: str, location: str, summary: str) -> dict[str, Any]:
        """A 'What's new' update on the business's Google profile."""
        return await self._req("POST", f"{GBP_V4}/{location}/localPosts", token,
                               json={"languageCode": "en-IN", "summary": summary, "topicType": "STANDARD"})

    # --- Gmail ----------------------------------------------------------------
    async def list_message_ids(self, token: str, query: str, max_results: int = 25) -> list[str]:
        body = await self._req("GET", f"{GMAIL}/messages", token,
                               params={"q": query, "maxResults": max_results})
        return [m["id"] for m in body.get("messages", [])]

    async def get_message(self, token: str, message_id: str) -> GmailMessage:
        m = await self._req("GET", f"{GMAIL}/messages/{message_id}", token, params={"format": "full"})
        raw_headers = m.get("payload", {}).get("headers", [])
        headers = {h["name"].lower(): h["value"] for h in raw_headers}
        auth = [h["value"] for h in raw_headers if h["name"].lower() == "authentication-results"]
        body, attachments = _walk_parts(m.get("payload", {}))
        name, addr = parseaddr(headers.get("from", ""))
        return GmailMessage(id=m["id"], thread_id=m.get("threadId", ""), sender=name or addr,
                            sender_email=addr.lower(), to=headers.get("to", ""),
                            subject=headers.get("subject", ""), date=headers.get("date", ""),
                            body=body or m.get("snippet", ""), attachments=attachments,
                            authenticated=sender_authenticated(auth, addr.lower()),
                            automated=automated_sender(addr.lower(), headers))

    async def get_attachment(self, token: str, message_id: str, attachment_id: str) -> bytes:
        body = await self._req("GET", f"{GMAIL}/messages/{message_id}/attachments/{attachment_id}", token)
        return base64.urlsafe_b64decode(body["data"])

    async def send_email(self, token: str, *, to: str, subject: str, body: str, sender: str | None = None,
                         cc: list[str] | None = None, thread_id: str | None = None,
                         attachments: list[tuple[str, str, bytes]] | None = None,
                         headers: dict[str, str] | None = None) -> dict[str, str]:
        """Returns {"id", "thread_id"}: the thread lets a reply be matched to what was sent. `headers`: extra
        headers such as List-Unsubscribe for campaign emails."""
        msg = EmailMessage(policy=LONG_HEADERS)   # long URLs in List-Unsubscribe stay plain (no RFC 2047 encoding)
        msg["To"] = to
        msg["Subject"] = subject
        if sender:
            msg["From"] = sender
        if cc:
            msg["Cc"] = ", ".join(cc)
        for k, v in (headers or {}).items():
            msg[k] = v
        msg.set_content(body)
        for filename, mime, data in attachments or []:
            maintype, _, subtype = mime.partition("/")
            msg.add_attachment(data, maintype=maintype, subtype=subtype or "octet-stream", filename=filename)
        payload: dict[str, Any] = {"raw": base64.urlsafe_b64encode(msg.as_bytes()).decode()}
        if thread_id:
            payload["threadId"] = thread_id
        res = await self._req("POST", f"{GMAIL}/messages/send", token, json=payload)
        return {"id": res.get("id", ""), "thread_id": res.get("threadId", "")}

    # --- Calendar ---------------------------------------------------------------
    async def create_event(self, token: str, *, summary: str, start: str, end: str,
                           attendees: list[str], description: str = "",
                           timezone: str = "Asia/Kolkata") -> dict[str, str]:
        body = {
            "summary": summary, "description": description,
            "start": {"dateTime": start, "timeZone": timezone},
            "end": {"dateTime": end, "timeZone": timezone},
            "attendees": [{"email": a} for a in attendees],
        }
        res = await self._req("POST", f"{CALENDAR}/calendars/primary/events", token,
                              params={"sendUpdates": "all"}, json=body)
        return {"id": res.get("id", ""), "link": res.get("htmlLink", "")}

    async def busy(self, token: str, start: str, end: str) -> list[dict[str, str]]:
        """Timed, non-transparent events on the primary calendar between two RFC 3339 times."""
        body = await self._req("GET", f"{CALENDAR}/calendars/primary/events", token, params={
            "timeMin": start, "timeMax": end, "singleEvents": "true", "maxResults": 250,
            "fields": "items(id,start/dateTime,end/dateTime,transparency,status)"})
        out = []
        for e in body.get("items", []):
            st, en = (e.get("start") or {}).get("dateTime"), (e.get("end") or {}).get("dateTime")
            if st and en and e.get("transparency") != "transparent" and e.get("status") != "cancelled":
                out.append({"id": e.get("id", ""), "start": st, "end": en})
        return out

    # --- Drive ------------------------------------------------------------------
    async def list_drive_files(self, token: str, query: str = "trashed = false",
                               page_size: int = 50) -> list[dict[str, Any]]:
        body = await self._req("GET", f"{DRIVE}/files", token, params={
            "q": query, "pageSize": page_size,
            "fields": "files(id,name,mimeType,modifiedTime,webViewLink,size)"})
        return body.get("files", [])

    async def get_drive_file(self, token: str, file_id: str) -> dict[str, Any]:
        """One file's details. With drive.file this works only for files the person picked for Kritvia."""
        return await self._req("GET", f"{DRIVE}/files/{file_id}", token,
                               params={"fields": "id,name,mimeType,modifiedTime,webViewLink,size,trashed"})

    async def download_drive_file(self, token: str, file: dict[str, Any]) -> tuple[bytes, str]:
        mime = file.get("mimeType", "")
        if mime.startswith("application/vnd.google-apps."):
            export = "text/plain" if "document" in mime or "presentation" in mime else "text/csv"
            r = await self._http.get(f"{DRIVE}/files/{file['id']}/export", params={"mimeType": export},
                                     headers={"Authorization": f"Bearer {token}"})
            mime = export
        else:
            r = await self._http.get(f"{DRIVE}/files/{file['id']}", params={"alt": "media"},
                                     headers={"Authorization": f"Bearer {token}"})
        if r.status_code >= 400:
            raise GoogleError(f"drive download failed: HTTP {r.status_code}")
        return r.content, mime


def _walk_parts(part: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    """Prefer text/plain; fall back to stripped text/html. Collect attachment refs."""
    plain, html, attachments = [], [], []

    def visit(p: dict[str, Any]) -> None:
        mime = p.get("mimeType", "")
        body = p.get("body", {})
        if p.get("filename") and body.get("attachmentId"):
            attachments.append({"filename": p["filename"], "mime": mime,
                                "attachment_id": body["attachmentId"], "size": body.get("size", 0)})
        elif mime == "text/plain" and body.get("data"):
            plain.append(base64.urlsafe_b64decode(body["data"]).decode("utf-8", "replace"))
        elif mime == "text/html" and body.get("data"):
            html.append(base64.urlsafe_b64decode(body["data"]).decode("utf-8", "replace"))
        for child in p.get("parts", []) or []:
            visit(child)

    visit(part)
    if plain:
        return "\n".join(plain).strip(), attachments
    if html:
        from kritvia_api.services.textextract import html_to_text
        return html_to_text("\n".join(html)), attachments
    return "", attachments
