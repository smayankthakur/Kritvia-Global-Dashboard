"""Amazon SES bounce and complaint feedback (test report round 2, P15).

SES publishes bounces and complaints to an SNS topic; the topic delivers them here
(`POST /hooks/ses/feedback`, an HTTPS subscription). Addresses that hard-bounce or complain go on the
suppression list, and Kritvia's system email (sign-in codes, digests) stops going to them: above 5%
bounces or 0.1% complaints SES suspends the whole account's sending.

Off until SES_FEEDBACK_TOPIC_ARN is set. Every message is checked: it must come from that topic and
carry a valid SNS signature (the signing certificate is fetched only from sns.<region>.amazonaws.com).
A subscription confirmation is accepted the same way (the confirm link must be on amazonaws.com too).

Set up once (AWS console, SES region):
  SNS → create topic "kritvia-ses-feedback" → subscription HTTPS https://api.<domain>/hooks/ses/feedback
  SES → Identities → the sending domain → Notifications → Bounce and Complaint feedback → that topic
  .env: SES_FEEDBACK_TOPIC_ARN=arn:aws:sns:<region>:<account>:kritvia-ses-feedback
"""
from __future__ import annotations

import base64
import json
import logging
import re
import time
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import text

from kritvia_api.config import get_settings
from kritvia_api.db.session import tenant_tx

router = APIRouter(tags=["webhooks"])
log = logging.getLogger("kritvia.ses")

_CERT_HOST = re.compile(r"^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$")
_CONFIRM_HOST = re.compile(r"^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$")
_certs: dict[str, tuple[float, Any]] = {}
transport_override: httpx.AsyncBaseTransport | None = None    # tests

_FIELDS = {
    "Notification": ("Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"),
    "SubscriptionConfirmation": ("Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"),
    "UnsubscribeConfirmation": ("Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"),
}


def canonical(msg: dict[str, Any]) -> bytes:
    """The text SNS signs: the message's fields, in this order, as "Name\\nvalue\\n" (absent ones left out)."""
    fields = _FIELDS.get(str(msg.get("Type")), ())
    return "".join(f"{k}\n{msg[k]}\n" for k in fields if k in msg and msg[k] is not None).encode()


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=10, follow_redirects=False, transport=transport_override)


async def _cert(url: str):
    from cryptography import x509
    u = urlparse(url)
    if u.scheme != "https" or not _CERT_HOST.match(u.hostname or "") or not u.path.endswith(".pem"):
        raise ValueError("signing certificate is not from Amazon SNS")
    hit = _certs.get(url)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    async with _client() as c:
        r = await c.get(url)
        r.raise_for_status()
    cert = x509.load_pem_x509_certificate(r.content)
    _certs[url] = (time.monotonic() + 3600, cert)
    return cert


async def verify(msg: dict[str, Any]) -> bool:
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding
    try:
        cert = await _cert(str(msg.get("SigningCertURL") or msg.get("SigningCertUrl") or ""))
        algo = hashes.SHA256() if str(msg.get("SignatureVersion")) == "2" else hashes.SHA1()
        cert.public_key().verify(base64.b64decode(str(msg.get("Signature", ""))), canonical(msg), padding.PKCS1v15(), algo)
        return True
    except (InvalidSignature, ValueError, httpx.HTTPError, TypeError):
        return False


def recipients(notification: dict[str, Any]) -> list[tuple[str, str, str]]:
    """(address, 'bounce' | 'complaint', detail) for permanent bounces and complaints; nothing else."""
    kind = str(notification.get("notificationType") or notification.get("eventType") or "")
    out: list[tuple[str, str, str]] = []
    if kind == "Bounce":
        b = notification.get("bounce") or {}
        if b.get("bounceType") != "Permanent":
            return []                       # a full mailbox or a passing problem: try again next time
        for r in b.get("bouncedRecipients") or []:
            if r.get("emailAddress"):
                out.append((str(r["emailAddress"]), "bounce", str(r.get("diagnosticCode") or b.get("bounceSubType") or "")[:300]))
    elif kind == "Complaint":
        c = notification.get("complaint") or {}
        for r in c.get("complainedRecipients") or []:
            if r.get("emailAddress"):
                out.append((str(r["emailAddress"]), "complaint", str(c.get("complaintFeedbackType") or "")[:300]))
    return out


@router.post("/hooks/ses/feedback", status_code=200)
async def ses_feedback(request: Request) -> dict:
    topic = get_settings().ses_feedback_topic_arn
    if not topic:
        raise HTTPException(404, "not found")
    try:
        msg = json.loads(await request.body())
    except ValueError:
        raise HTTPException(422, "body must be JSON") from None
    if not isinstance(msg, dict) or msg.get("TopicArn") != topic:
        raise HTTPException(403, "unknown topic")
    if not await verify(msg):
        raise HTTPException(403, "bad signature")
    kind = msg.get("Type")
    if kind == "SubscriptionConfirmation":
        u = urlparse(str(msg.get("SubscribeURL") or ""))
        if u.scheme != "https" or not _CONFIRM_HOST.match(u.hostname or ""):
            raise HTTPException(422, "confirmation link is not from Amazon SNS")
        async with _client() as c:
            await c.get(msg["SubscribeURL"])
        log.info("SES feedback subscription confirmed")
        return {"confirmed": True}
    if kind != "Notification":
        return {"ignored": True}
    try:
        notification = json.loads(msg.get("Message") or "{}")
    except ValueError:
        return {"ignored": True}
    found = recipients(notification if isinstance(notification, dict) else {})
    if found:
        async with tenant_tx(None, "system") as conn:
            for address, reason, detail in found:
                await conn.execute(text("SELECT private.suppress_email(:a, :r, :d)"), {"a": address, "r": reason, "d": detail})
        log.warning("SES feedback: %d address(es) suppressed (%s)", len(found), ", ".join(sorted({r for _, r, _ in found})))
    return {"suppressed": len(found)}
