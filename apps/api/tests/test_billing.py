"""Billing: owners subscribe through Razorpay; only a correctly signed webhook changes the plan."""
from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid

import httpx

from conftest import make_actor
from kritvia_api.config import get_settings
from kritvia_api.routers import billing

SECRET = "whsec_test"


def _configure(monkeypatch):
    s = get_settings()
    for k, v in {"razorpay_key_id": "rzp_test_x", "razorpay_key_secret": "sec", "razorpay_webhook_secret": SECRET,
                 "razorpay_plan_starter": "plan_S", "razorpay_plan_pro": "plan_P", "default_plan": "free"}.items():
        monkeypatch.setattr(s, k, v)
    seen = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.method, req.url.path, json.loads(req.content or b"{}")))
        if req.url.path.endswith("/subscriptions"):
            return httpx.Response(200, json={"id": "sub_123", "short_url": "https://rzp.io/i/abc"})
        if req.url.path.endswith("/cancel"):
            return httpx.Response(200, json={"id": "sub_123", "status": "active"})
        return httpx.Response(404, json={"error": {"description": "nope"}})
    monkeypatch.setattr(billing, "transport", httpx.MockTransport(handler))
    return seen


def _hook(org: str, event: str, status: str, eid: str) -> tuple[bytes, dict]:
    body = json.dumps({"event": event, "payload": {"subscription": {"entity": {
        "id": "sub_123", "plan_id": "plan_S", "status": status, "current_end": int(time.time()) + 30 * 86400,
        "notes": {"org_id": org, "plan": "starter"}}}}}).encode()
    sig = hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()
    return body, {"x-razorpay-signature": sig, "x-razorpay-event-id": eid, "content-type": "application/json"}


async def test_subscribe_webhook_upgrade_and_cancel(client, monkeypatch):
    seen = _configure(monkeypatch)
    owner = await make_actor(client, "payer")
    org = (await owner.post("/orgs", json={"name": "Pay Co", "slug": "pay-" + uuid.uuid4().hex[:8]})).json()["id"]

    r = await owner.put(f"/orgs/{org}/billing/profile", json={"legal_name": "Pay Co Pvt Ltd", "gstin": "07ABCDE1234F1Z5",
                                                              "state_code": "07", "address": "New Delhi"})
    assert r.status_code == 200, r.text
    assert (await owner.put(f"/orgs/{org}/billing/profile", json={"legal_name": "X", "gstin": "07ABCDE1234F1Z5",
                                                                  "state_code": "09"})).status_code == 422

    r = await owner.post(f"/orgs/{org}/billing/subscribe", json={"plan": "starter"})
    assert r.status_code == 200 and r.json()["checkout_url"] == "https://rzp.io/i/abc"
    assert seen[0][2]["plan_id"] == "plan_S" and seen[0][2]["notes"]["org_id"] == org
    assert seen[0][2]["notes"]["gstin"] == "07ABCDE1234F1Z5"
    # nothing changes until Razorpay confirms
    assert (await owner.get(f"/orgs/{org}/plan")).json()["plan"]["code"] == "free"

    body, h = _hook(org, "subscription.activated", "active", "evt_1")
    bad = await client.post("/public/billing/razorpay", content=body, headers={**h, "x-razorpay-signature": "0" * 64})
    assert bad.status_code == 401
    ok = await client.post("/public/billing/razorpay", content=body, headers=h)
    assert ok.status_code == 200 and ok.json()["duplicate"] is False
    again = await client.post("/public/billing/razorpay", content=body, headers=h)
    assert again.json()["duplicate"] is True
    plan = (await owner.get(f"/orgs/{org}/plan")).json()
    assert plan["plan"]["code"] == "starter" and plan["renews_at"]

    b = (await owner.get(f"/orgs/{org}/billing")).json()
    assert b["configured"] and b["subscription_id"] == "sub_123" and b["events"][0]["event"] == "subscription.activated"

    assert (await owner.post(f"/orgs/{org}/billing/cancel")).status_code == 202
    body, h = _hook(org, "subscription.cancelled", "cancelled", "evt_2")
    await client.post("/public/billing/razorpay", content=body, headers=h)
    assert (await owner.get(f"/orgs/{org}/plan")).json()["plan"]["code"] == "free"


async def test_billing_is_owner_only(world, monkeypatch):
    _configure(monkeypatch)
    alice, org = world["alice"], world["org"]          # alice operates a venture, does not own the org
    assert (await alice.get(f"/orgs/{org}/billing")).status_code == 404
    assert (await alice.post(f"/orgs/{org}/billing/subscribe", json={"plan": "pro"})).status_code == 404


async def test_webhook_cannot_downgrade_internal(client, monkeypatch, world):
    _configure(monkeypatch)
    import asyncpg
    from conftest import ADMIN_DSN
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute("SELECT set_org_plan($1, 'internal', NULL)", uuid.UUID(world["org"]))
    finally:
        await conn.close()
    body, h = _hook(world["org"], "subscription.cancelled", "cancelled", "evt_int_" + uuid.uuid4().hex)
    assert (await client.post("/public/billing/razorpay", content=body, headers=h)).status_code == 200
    assert (await world["mayank"].get(f"/orgs/{world['org']}/plan")).json()["plan"]["code"] == "internal"
