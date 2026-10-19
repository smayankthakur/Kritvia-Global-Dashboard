"""Mail forwarded to a business's Kritvia address (migration 0031).

Cloudflare Email Routing hands each message to infra/cloudflare/email-worker.js, which posts the
raw message (RFC 822) to POST /public/email-in with

    X-Kritvia-To         the address it was sent to
    X-Kritvia-Timestamp  unix seconds
    X-Kritvia-Signature  sha256=HMAC(INBOUND_EMAIL_SECRET, "<timestamp>.<raw message>")

Forwarded mail is treated as unauthenticated: Kritvia cannot check who really sent it, so it is
used for replies and enquiries (which a person approves) and never to file identity papers or
sales reports (those still need Gmail connected with read access).
"""
from __future__ import annotations

import hashlib
import hmac
import re
import time
from dataclasses import dataclass, field
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import getaddresses, parseaddr
from html import unescape
from typing import Any

MAX_BODY = 200_000
GMAIL_CONFIRM_SENDER = "forwarding-noreply@google.com"
LOCAL_PART = re.compile(r"^[a-z0-9][a-z0-9-]{2,62}$")


@dataclass
class InboundMail:
    """The same fields the Gmail poller's handlers read from a GmailMessage."""
    id: str
    thread_id: str
    sender: str
    sender_email: str
    to: str
    subject: str
    date: str
    body: str
    attachments: list[dict[str, Any]] = field(default_factory=list)
    authenticated: bool = False
    headers: dict[str, str] = field(default_factory=dict)


def sign(secret: str, timestamp: str, raw: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), timestamp.encode() + b"." + raw, hashlib.sha256).hexdigest()


def signature_ok(secret: str, timestamp: str | None, raw: bytes, signature: str | None, *, now: float | None = None,
                 window_s: int = 300) -> bool:
    if not secret or not timestamp or not signature or not timestamp.isdigit():
        return False
    if abs((now or time.time()) - int(timestamp)) > window_s:
        return False
    return hmac.compare_digest(signature, sign(secret, timestamp, raw))


def local_part(address: str, domain: str) -> str | None:
    """'sitelytc-7f3k9q2m4d@in.sitelytc.com' -> 'sitelytc-7f3k9q2m4d' when the domain is ours."""
    _, addr = parseaddr(address or "")
    local, _, dom = addr.lower().rpartition("@")
    local = local.split("+", 1)[0]
    if not local or dom != domain.lower() or not LOCAL_PART.match(local):
        return None
    return local


def _html_text(html: str) -> str:
    html = re.sub(r"(?is)<(script|style).*?</\1>", " ", html)
    html = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>", "\n", html)
    return re.sub(r"[ \t]+", " ", unescape(re.sub(r"<[^>]+>", " ", html))).strip()


def parse(raw: bytes) -> InboundMail:
    msg: EmailMessage = BytesParser(policy=policy.default).parsebytes(raw)   # type: ignore[assignment]
    name, addr = parseaddr(str(msg.get("From", "")))
    plain, html, attachments = "", "", []
    for part in msg.walk():
        if part.is_multipart():
            continue
        disposition = part.get_content_disposition()
        ctype = part.get_content_type()
        if disposition == "attachment" or (part.get_filename() and disposition != "inline"):
            data = part.get_payload(decode=True) or b""
            attachments.append({"filename": part.get_filename() or "attachment", "mime": ctype, "size": len(data),
                                "data": data})
        elif ctype == "text/plain" and not plain:
            plain = str(part.get_content())
        elif ctype == "text/html" and not html:
            html = str(part.get_content())
    body = (plain or _html_text(html))[:MAX_BODY]
    message_id = str(msg.get("Message-ID", "")).strip() or "sha256:" + hashlib.sha256(raw).hexdigest()
    to = ", ".join(a for _, a in getaddresses([str(msg.get("To", ""))]) if a)
    return InboundMail(id=message_id[:300], thread_id="", sender=name or addr, sender_email=addr.lower(), to=to,
                       subject=str(msg.get("Subject", ""))[:500], date=str(msg.get("Date", "")), body=body,
                       attachments=attachments, authenticated=False,
                       headers={k.lower(): str(v)[:500] for k, v in msg.items()})


CONFIRM_CODE = re.compile(r"(?:confirmation code|#)\s*:?\s*(\d{6,12})", re.I)
# Gmail's newer confirmation has no code, only a link on Google's own domain:
#   https://mail.google.com/mail/vf-%5B...%5D-...   (older: mail-settings.google.com/mail/vf-...)
CONFIRM_LINK = re.compile(r"https://(?:mail|mail-settings)\.google\.com/mail/(?:u/\d+/)?vf-[^\s<>\"')\]]{8,600}")
REQUESTER = re.compile(r"([\w.+-]+@[\w-]+(?:\.[\w-]+)+) has requested", re.I)


def gmail_confirmation(m: InboundMail) -> dict[str, str] | None:
    """Gmail's 'confirm this forwarding address' message: the code (older messages) or the confirmation link
    (newer ones), and the mailbox asking. The link is only ever one on Google's own mail domain."""
    if m.sender_email != GMAIL_CONFIRM_SENDER:
        return None
    text = f"{m.subject}\n{m.body}"
    if "forwarding confirmation" not in text.lower():
        return None
    code = CONFIRM_CODE.search(m.subject) or CONFIRM_CODE.search(m.body)
    link = CONFIRM_LINK.search(m.body)
    who = REQUESTER.search(m.body) or re.search(r"([\w.+-]+@[\w-]+(?:\.[\w-]+)+)", m.subject.split("from", 1)[-1])
    if not code and not link:
        return None
    return {"code": code.group(1) if code else "", "link": link.group(0) if link else "",
            "mailbox": who.group(1).lower() if who else ""}
