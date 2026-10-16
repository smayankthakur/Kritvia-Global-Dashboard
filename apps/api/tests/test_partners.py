"""Partner programme: a CA applies and is approved by Kritvia's team; a business that signs up with the
code gets the partner's discount offer at checkout; each confirmed payment earns the partner 20% once;
the team records payouts. Partners see their referred businesses' names and plans, never their data."""
from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid

from conftest import make_actor
from kritvia_api.config import get_settings
from test_billing import SECRET, _configure


def charged(org: str, pay_id: str, paise: int, eid: str) -> tuple[bytes, dict]:
    body = json.dumps({"event": "subscription.charged", "payload": {
        "subscription": {"entity": {"id": "sub_123", "plan_id": "plan_S", "status": "active",
                                    "current_end": int(time.time()) + 30 * 86400, "notes": {"org_id": org}}},
        "payment": {"entity": {"id": pay_id, "amount": paise, "notes": {"org_id": org}}}}}).encode()
    return body, {"x-razorpay-signature": hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest(),
                  "x-razorpay-event-id": eid, "content-type": "application/json"}


async def test_apply_approve_refer_earn_and_pay_out(client, monkeypatch, world):
    seen = _configure(monkeypatch)
    s = get_settings()
    monkeypatch.setattr(s, "razorpay_partner_offer_id", "offer_PARTNER10")
    ca = await make_actor(client, "ca-mehta")
    staff = world["mayank"]
    monkeypatch.setattr(s, "staff_emails", staff.email)

    assert (await ca.get("/partners/me")).json()["partner"] is None
    r = await ca.post("/partners/apply", json={"name": "Anil Mehta", "firm": "Mehta & Co", "kind": "ca",
                                                "city": "Indore", "upi_id": "anil@okhdfc", "code": "MEHTA10"})
    assert r.status_code == 201, r.text
    p = r.json()
    assert p["code"] == "MEHTA10" and p["status"] == "applied" and p["link"].endswith("/register?ref=MEHTA10")
    assert (await ca.post("/partners/apply", json={"name": "Again", "kind": "ca"})).status_code == 409
    # a partner can't approve themselves
    assert (await ca.get("/staff/partners")).status_code == 404
    assert (await ca.post(f"/staff/partners/{p['id']}/status", json={"status": "active"})).status_code == 404

    # a business tries the code before approval: unknown
    owner = await make_actor(client, "referred-owner")
    org = (await owner.post("/orgs", json={"name": "Sharma Traders", "slug": "sharma-" + uuid.uuid4().hex[:6]})).json()["id"]
    assert (await owner.post(f"/orgs/{org}/partner-code", json={"code": "mehta10"})).status_code == 404
    lst = (await staff.get("/staff/partners")).json()
    assert any(x["code"] == "MEHTA10" and x["status"] == "applied" for x in lst)
    await staff.post(f"/staff/partners/{p['id']}/status", json={"status": "active"})

    r = await owner.post(f"/orgs/{org}/partner-code", json={"code": "mehta10"})
    assert r.status_code == 200 and r.json()["partner"] == "Mehta & Co" and "10%" in r.json()["discount"]
    assert (await owner.post(f"/orgs/{org}/partner-code", json={"code": "MEHTA10"})).status_code == 409
    # the partner can't refer their own organisation
    own = (await ca.post("/orgs", json={"name": "Mehta Office", "slug": "mehta-" + uuid.uuid4().hex[:6]})).json()["id"]
    assert (await ca.post(f"/orgs/{own}/partner-code", json={"code": "MEHTA10"})).status_code == 422

    # checkout carries the partner offer; a discounted charge still grants the plan
    await owner.put(f"/orgs/{org}/billing/profile", json={"legal_name": "Sharma Traders", "state_code": "23", "address": "Indore"})
    assert (await owner.post(f"/orgs/{org}/billing/subscribe", json={"plan": "starter"})).status_code == 200
    assert seen[-1][2]["offer_id"] == "offer_PARTNER10"
    body, h = charged(org, "pay_A", 224910, "evt_p1")             # ₹2,499 less 10%
    assert (await client.post("/public/billing/razorpay", content=body, headers=h)).status_code == 200
    assert (await owner.get(f"/orgs/{org}/plan")).json()["plan"]["code"] == "starter"
    # the same payment again: no second commission
    body2, h2 = charged(org, "pay_A", 224910, "evt_p1b")
    await client.post("/public/billing/razorpay", content=body2, headers=h2)
    body3, h3 = charged(org, "pay_B", 224910, "evt_p2")
    await client.post("/public/billing/razorpay", content=body3, headers=h3)

    page = (await ca.get("/partners/me")).json()
    assert page["partner"]["status"] == "active" and len(page["referrals"]) == 1
    ref = page["referrals"][0]
    assert ref["name"] == "Sharma Traders" and ref["plan"] == "starter" and ref["earned_paise"] == 2 * 44982
    assert page["earned_paise"] == 89964 and page["due_paise"] == 89964 and "20%" in page["terms"]
    # someone else's view: nothing
    assert (await owner.get("/partners/me")).json()["partner"] is None

    # payout of everything due, with its reference
    assert (await staff.post(f"/staff/partners/{p['id']}/payout", json={"reference": "UPI 612345678901"})).json()["paid_paise"] == 89964
    assert (await staff.post(f"/staff/partners/{p['id']}/payout", json={"reference": "again"})).status_code == 409
    page = (await ca.get("/partners/me")).json()
    assert page["due_paise"] == 0 and page["paid_paise"] == 89964 and page["payouts"][0]["reference"] == "UPI 612345678901"

    # a partner edits payout details but never their status or code
    r = await ca.patch("/partners/me", json={"name": "Anil Mehta", "firm": "Mehta & Co", "upi_id": "mehta@okicici"})
    assert r.json()["upi_id"] == "mehta@okicici" and r.json()["status"] == "active"
