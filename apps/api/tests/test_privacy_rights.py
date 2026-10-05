"""Privacy rights: anyone can file a request and gets a reference and deadlines; the grievance
inbox is told; one-click unsubscribe is signed and never touches sign-in codes; every system
email says who sent it."""
from __future__ import annotations

import uuid

import asyncpg
import pytest

from conftest import ADMIN_DSN, make_actor

from kritvia_api.config import get_settings
from kritvia_api.db.session import tenant_tx
from kritvia_api.routers.privacy import one_click_url, send_product_email, unsubscribe_token, unsubscribe_url
from kritvia_api.services.mailer import get_mailer

pytestmark = pytest.mark.asyncio


async def test_anyone_can_file_a_privacy_request(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "support_inbox", "grievance@sitelytc.example")
    body = {"kind": "erase", "relationship": "business_customer", "name": "Ravi Kumar",
            "email": f"ravi-{uuid.uuid4().hex[:6]}@example.com", "business_name": "Annapurna Rasoi",
            "details": "Please delete my phone number and order history."}
    r = await client.post("/public/privacy-requests", json=body, headers={"X-Forwarded-For": "203.0.113.50"})
    assert r.status_code == 202, r.text
    out = r.json()
    assert out["reference"].startswith("PR-") and len(out["reference"]) == 11
    assert out["acknowledge_by"] < out["respond_by"]
    mail = [m for m in get_mailer().outbox if m["To"] == "grievance@sitelytc.example"][-1]
    assert out["reference"] in mail["Subject"] and "Annapurna Rasoi" in mail.get_content()
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        row = await conn.fetchrow("SELECT kind, status, respond_by - created_at AS window FROM privacy_requests"
                                  " WHERE reference = $1", out["reference"])
        # nobody but the operator can read requests: the app role has no access to the table
        await conn.execute("SET ROLE kritvia_app")
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await conn.fetchval("SELECT count(*) FROM privacy_requests")
        await conn.execute("RESET ROLE")
    finally:
        await conn.close()
    assert row["kind"] == "erase" and row["status"] == "received" and row["window"].days == 30
    # validation: an unknown request type is refused
    bad = await client.post("/public/privacy-requests", json={**body, "kind": "sell"},
                            headers={"X-Forwarded-For": "203.0.113.51"})
    assert bad.status_code == 422


async def test_one_click_unsubscribe_is_signed(client):
    who = await make_actor(client, "unsub")
    token = unsubscribe_token(who.id)
    assert unsubscribe_url(who.id).endswith(f"/unsubscribe?t={token}")
    forged = unsubscribe_token(uuid.uuid4())
    tampered = forged[:22] + token[22:]
    assert (await client.post("/public/unsubscribe", json={"token": tampered})).status_code == 400
    assert one_click_url(who.id).endswith(f"/api/unsubscribe?t={token}")
    async with tenant_tx(None, "system") as conn:
        assert await send_product_email(conn, who.id, who.email, "Tips for your first week", "Hello")
    sent = get_mailer().outbox[-1]
    assert sent["List-Unsubscribe"] == f"<{one_click_url(who.id)}>" and unsubscribe_url(who.id) in sent.get_content()
    r = await client.post("/public/unsubscribe", json={"token": token})
    assert r.status_code == 200 and r.json() == {"subscribed": False}
    async with tenant_tx(None, "system") as conn:
        assert not await send_product_email(conn, who.id, who.email, "More tips", "Hello")   # opted out
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        assert await conn.fetchval("SELECT product_email_optout_at FROM users WHERE id = $1", who.id) is not None
        await client.post("/public/unsubscribe", json={"token": token, "resubscribe": True})
        assert await conn.fetchval("SELECT product_email_optout_at FROM users WHERE id = $1", who.id) is None
    finally:
        await conn.close()


async def test_product_email_carries_unsubscribe_headers_and_sender_details():
    mailer = get_mailer()
    url = "https://app.example/unsubscribe?t=abc"
    await mailer.send("owner@example.com", "Your weekly summary", "Three drafts were approved.", unsubscribe_url=url)
    m = mailer.outbox[-1]
    assert m["List-Unsubscribe"] == f"<{url}>" and m["List-Unsubscribe-Post"] == "List-Unsubscribe=One-Click"
    body = m.get_content()
    assert "Unsubscribe in one click" in body and get_settings().company_cin in body
    # transactional mail (sign-in codes) never offers an unsubscribe
    await mailer.send("owner@example.com", "123456 is your Kritvia sign-in code", "Your code is 123456")
    t = mailer.outbox[-1]
    assert t["List-Unsubscribe"] is None and "Unsubscribe" not in t.get_content()
    assert "Sitelytc Digital Media Private Limited" in t.get_content()
