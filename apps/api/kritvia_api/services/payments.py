"""Getting paid: UPI links and the business's own Razorpay payment links.

UPI: the business's UPI ID goes into a standard upi://pay link (and a QR of it on the payment page).
Any UPI app opens it with the payee and amount filled in. Kritvia can't see such a payment, so the
customer can say "I've paid" on the page and a person confirms it.

Razorpay: the business connects its own account (key id and key secret, from Razorpay Dashboard →
Account & Settings → API keys). When a customer chooses to pay online, Kritvia creates a Razorpay
payment link for the amount still owed. Razorpay's webhook (payment_link.paid), signed with the secret
Kritvia generated for that business, records the payment and marks the invoice paid.

Secrets never appear in errors or logs written here.
"""
from __future__ import annotations

import hashlib
import hmac
import re
import uuid
from typing import Any
from urllib.parse import quote

import httpx

API = "https://api.razorpay.com/v1"
UPI_ID = re.compile(r"^[A-Za-z0-9._-]{2,255}@[A-Za-z][A-Za-z0-9.-]{1,63}$")
KEY_ID = re.compile(r"^rzp_(live|test)_[A-Za-z0-9]{8,32}$")


class RazorpayError(Exception):
    pass


def upi_link(upi_id: str, payee: str, paise: int, note: str) -> str:
    """upi://pay?pa=<id>&pn=<name>&am=<rupees>&cu=INR&tn=<note> (NPCI's deep-link format)."""
    rupees = f"{paise // 100}.{paise % 100:02d}"
    q = "&".join(f"{k}={quote(v, safe='@.-_')}" for k, v in (
        ("pa", upi_id), ("pn", payee[:50]), ("am", rupees), ("cu", "INR"), ("tn", note[:50])))
    return f"upi://pay?{q}"


def verify_webhook(secret: str, body: bytes, signature: str) -> bool:
    if not secret or not signature:
        return False
    return hmac.compare_digest(hmac.new(secret.encode(), body, hashlib.sha256).hexdigest(), signature)


class RazorpayClient:
    def __init__(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._http = httpx.AsyncClient(transport=transport, timeout=20, follow_redirects=False)

    async def _call(self, key_id: str, key_secret: str, method: str, path: str, body: dict | None = None) -> Any:
        try:
            r = await self._http.request(method, f"{API}{path}", json=body, auth=(key_id, key_secret))
        except httpx.HTTPError:
            raise RazorpayError("couldn't reach Razorpay; try again in a minute") from None
        try:
            data = r.json()
        except ValueError:
            data = {}
        if r.status_code == 401:
            raise RazorpayError("Razorpay didn't accept these keys; copy the key id and secret again "
                                "(Dashboard → Account & Settings → API keys)")
        if r.status_code >= 400:
            desc = ((data or {}).get("error") or {}).get("description") if isinstance(data, dict) else None
            raise RazorpayError(f"Razorpay refused it: {str(desc or r.status_code)[:200]}")
        return data

    async def check(self, key_id: str, key_secret: str) -> None:
        await self._call(key_id, key_secret, "GET", "/payment_links?count=1")

    async def create_link(self, key_id: str, key_secret: str, *, invoice_id: uuid.UUID, attempt: int, paise: int,
                          description: str, customer: dict[str, str], back_url: str) -> dict[str, Any]:
        body = {
            "amount": paise, "currency": "INR", "accept_partial": False,
            # unique per link in the business's Razorpay account
            "reference_id": f"kv-{invoice_id.hex[:24]}-{attempt}",
            "description": description[:2048],
            "customer": {k: v for k, v in customer.items() if v},
            "notify": {"sms": False, "email": False}, "reminder_enable": False,
            "notes": {"kritvia_invoice": str(invoice_id)},
            "callback_url": back_url, "callback_method": "get",
        }
        out = await self._call(key_id, key_secret, "POST", "/payment_links", body)
        if not isinstance(out, dict) or not out.get("id") or not str(out.get("short_url", "")).startswith("https://"):
            raise RazorpayError("Razorpay didn't return a payment link")
        return out


def paid_event(payload: Any) -> dict[str, Any] | None:
    """payment_link.paid -> {link_id, payment_id, paise, method}; None for any other event."""
    if not isinstance(payload, dict) or payload.get("event") != "payment_link.paid":
        return None
    p = payload.get("payload") or {}
    link = ((p.get("payment_link") or {}).get("entity") or {})
    pay = ((p.get("payment") or {}).get("entity") or {})
    if not link.get("id") or not pay.get("id"):
        return None
    try:
        paise = int(pay.get("amount") or link.get("amount_paid") or 0)
    except (TypeError, ValueError):
        return None
    if paise <= 0:
        return None
    return {"link_id": str(link["id"])[:60], "payment_id": str(pay["id"])[:80], "paise": paise,
            "method": str(pay.get("method") or "")[:20]}
