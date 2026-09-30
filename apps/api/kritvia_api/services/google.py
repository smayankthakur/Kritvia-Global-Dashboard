"""Google Workspace connector: OAuth (offline access), Gmail, Calendar, Drive.

Plain REST over httpx (no Google SDK) so the transport is injectable in tests.
During dogfooding the OAuth app stays in "testing" mode (no verification
needed); external users require Google's verification and, for restricted
Gmail scopes, a paid security assessment (Phase 2).
"""
from __future__ import annotations

import base64
import time
import uuid
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import parseaddr
from typing import Any
from urllib.parse import urlencode

import httpx

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
}
DEFAULT_SCOPES = ["openid", "email", *SCOPES.values()]


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

    # --- Gmail ----------------------------------------------------------------
    async def list_message_ids(self, token: str, query: str, max_results: int = 25) -> list[str]:
        body = await self._req("GET", f"{GMAIL}/messages", token,
                               params={"q": query, "maxResults": max_results})
        return [m["id"] for m in body.get("messages", [])]

    async def get_message(self, token: str, message_id: str) -> GmailMessage:
        m = await self._req("GET", f"{GMAIL}/messages/{message_id}", token, params={"format": "full"})
        headers = {h["name"].lower(): h["value"] for h in m.get("payload", {}).get("headers", [])}
        body, attachments = _walk_parts(m.get("payload", {}))
        name, addr = parseaddr(headers.get("from", ""))
        return GmailMessage(id=m["id"], thread_id=m.get("threadId", ""), sender=name or addr,
                            sender_email=addr.lower(), to=headers.get("to", ""),
                            subject=headers.get("subject", ""), date=headers.get("date", ""),
                            body=body or m.get("snippet", ""), attachments=attachments)

    async def get_attachment(self, token: str, message_id: str, attachment_id: str) -> bytes:
        body = await self._req("GET", f"{GMAIL}/messages/{message_id}/attachments/{attachment_id}", token)
        return base64.urlsafe_b64decode(body["data"])

    async def send_email(self, token: str, *, to: str, subject: str, body: str, sender: str | None = None,
                         cc: list[str] | None = None, thread_id: str | None = None,
                         attachments: list[tuple[str, str, bytes]] | None = None) -> str:
        msg = EmailMessage()
        msg["To"] = to
        msg["Subject"] = subject
        if sender:
            msg["From"] = sender
        if cc:
            msg["Cc"] = ", ".join(cc)
        msg.set_content(body)
        for filename, mime, data in attachments or []:
            maintype, _, subtype = mime.partition("/")
            msg.add_attachment(data, maintype=maintype, subtype=subtype or "octet-stream", filename=filename)
        payload: dict[str, Any] = {"raw": base64.urlsafe_b64encode(msg.as_bytes()).decode()}
        if thread_id:
            payload["threadId"] = thread_id
        res = await self._req("POST", f"{GMAIL}/messages/send", token, json=payload)
        return res.get("id", "")

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

    # --- Drive ------------------------------------------------------------------
    async def list_drive_files(self, token: str, query: str = "trashed = false",
                               page_size: int = 50) -> list[dict[str, Any]]:
        body = await self._req("GET", f"{DRIVE}/files", token, params={
            "q": query, "pageSize": page_size,
            "fields": "files(id,name,mimeType,modifiedTime,webViewLink,size)"})
        return body.get("files", [])

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
