"""Coupons for every kind of offer (migration 0065): Kritvia's team creates them with plans, industries, dates,
audiences and private lists; owners apply them; percent-off coupons ride on the Razorpay subscription."""
from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid
from datetime import UTC, datetime, timedelta

import pytest

from conftest import ADMIN_DSN, make_actor
from kritvia_api.config import get_settings
from kritvia_api.routers.coupons import offer_words
from test_billing import SECRET, _configure
from test_coupons import _admin_sql, _org

pytestmark = pytest.mark.asyncio


async def sql(q: str, *args):
    import asyncpg
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        return await conn.fetch(q, *args)
    finally:
        await conn.close()


def code(prefix: str) -> str:
    return f"{prefix}{uuid.uuid4().hex[:6].upper()}"


@pytest.fixture
async def staff(client, monkeypatch, world):
    monkeypatch.setattr(get_settings(), "default_plan", "free")
    monkeypatch.setattr(get_settings(), "staff_emails", world["mayank"].email)
    return world["mayank"]


async def venture(owner, org: str, industry: str | None = None, kind: str = "general") -> str:
    v = (await owner.post(f"/orgs/{org}/ventures", json={"name": "Shop", "slug": f"s-{uuid.uuid4().hex[:6]}"})).json()["id"]
    body = {"kind": kind, **({"industry": industry} if industry else {})}
    assert (await owner.put(f"/ventures/{v}/settings", json=body)).status_code == 200
    return v


def test_offers_in_words():
    assert offer_words("free_plan", plan="growth", days=45) == "Growth plan free for 45 days"
    assert offer_words("percent_off", percent=20, plans=["growth", "scale"], periods=["annual"], months=None) == \
        "20% off Growth or Scale plan (annual billing)"
    assert offer_words("percent_off", percent=15, months=3) == "15% off any plan for the first 3 billing cycles"
    assert offer_words("trial_days", days=30) == "30 extra days of free trial"
    assert offer_words("ai_tokens", tokens=500000, months=2) == "500,000 extra AI tokens a month for 2 months"


async def test_staff_create_edit_delete_and_validation(client, staff):
    c = code("NEW")
    bad = await staff.post("/staff/coupons", json={"code": c, "kind": "free_plan", "months": 2})
    assert bad.status_code == 422 and "plan" in bad.text
    bad = await staff.post("/staff/coupons", json={"code": c, "kind": "percent_off", "percent": 20})
    assert bad.status_code == 422
    bad = await staff.post("/staff/coupons", json={"code": c, "kind": "free_plan", "plan": "growth", "months": 2,
                                                   "days": 10})
    assert bad.status_code == 422
    bad = await staff.post("/staff/coupons", json={"code": c, "kind": "trial_days", "days": 10,
                                                   "starts_at": "2026-12-01T00:00:00Z", "expires_at": "2026-11-01T00:00:00Z"})
    assert bad.status_code == 422
    r = await staff.post("/staff/coupons", json={
        "code": c.lower(), "kind": "free_plan", "plan": "growth", "days": 45, "percent": 50,  # percent is dropped
        "industries": ["kitchen", "retail"], "who": "new", "signup_days": 14, "max_uses": 25,
        "emails": [" Asha@Example.com "], "domains": ["@Mehta.in"], "note": "Diwali kitchens"})
    assert r.status_code == 201, r.text
    got = next(x for x in r.json() if x["code"] == c)
    assert got["offer"] == "Growth plan free for 45 days" and got["percent"] is None and got["status"] == "open"
    assert got["emails"] == ["asha@example.com"] and got["domains"] == ["mehta.in"]
    assert "Industries: Restaurant or cloud kitchen, Shop or e-commerce" in got["conditions"]
    assert (await staff.post("/staff/coupons", json={"code": c, "kind": "trial_days", "days": 5})).status_code == 409
    # change it freely while unused
    upd = await staff.put(f"/staff/coupons/{c}", json={**{k: got[k] for k in (
        "kind", "plan", "days", "industries", "who", "signup_days", "emails", "domains", "max_uses", "note")},
        "days": 60, "expires_at": (datetime.now(UTC) + timedelta(days=30)).isoformat()})
    assert upd.status_code == 200, upd.text
    assert next(x for x in upd.json() if x["code"] == c)["offer"] == "Growth plan free for 60 days"
    sched = code("SOON")
    r = await staff.post("/staff/coupons", json={"code": sched, "kind": "trial_days", "days": 7,
                                                 "starts_at": (datetime.now(UTC) + timedelta(days=2)).isoformat()})
    assert next(x for x in r.json() if x["code"] == sched)["status"] == "scheduled"
    assert (await client.get(f"/public/coupons/{sched}")).json()["open"] is False
    opts = (await staff.get("/staff/coupons/options")).json()
    assert opts["industries"]["kitchen"] == "Restaurant or cloud kitchen" and "percent_off" in opts["kinds"]
    assert (await staff.delete(f"/staff/coupons/{sched}")).status_code == 204
    assert (await staff.delete(f"/staff/coupons/{sched}")).status_code == 404
    # someone who isn't staff
    other = await make_actor(client, "not-staff")
    assert (await other.post("/staff/coupons", json={"code": code("X"), "kind": "trial_days", "days": 3})).status_code == 404


async def test_audience_industry_and_private_codes(client, staff):
    c = code("KIT")
    await staff.post("/staff/coupons", json={"code": c, "kind": "free_plan", "plan": "growth", "months": 1,
                                             "industries": ["kitchen"], "who": "new", "signup_days": 7,
                                             "domains": ["kitchens.in"]})
    stranger = await make_actor(client, "cp-stranger")
    org0 = await _org(stranger)
    await venture(stranger, org0, "kitchen", "kitchen")
    r = await stranger.post(f"/orgs/{org0}/coupon", json={"code": c})
    assert r.status_code == 403 and "private" in r.text

    owner = await make_actor(client, "chef")
    await sql("UPDATE users SET email = $2 WHERE id = $1", uuid.UUID(str(owner.id)), f"chef{uuid.uuid4().hex[:6]}@kitchens.in")
    org = await _org(owner)
    v = await venture(owner, org, "agency", "software")
    r = await owner.post(f"/orgs/{org}/coupon", json={"code": c})
    assert r.status_code == 409 and "different kind of business" in r.text
    await owner.put(f"/ventures/{v}/settings", json={"industry": "kitchen", "kind": "kitchen"})
    assert (await owner.get(f"/ventures/{v}/settings")).json()["industry"] == "kitchen"
    # too long after signing up
    await sql("UPDATE coupons SET created_at = now() - interval '30 days' WHERE code = $1", c)
    await _admin_sql("UPDATE organisations SET created_at = now() - interval '10 days' WHERE id = $1", org)
    assert "soon after signing up" in (await owner.post(f"/orgs/{org}/coupon", json={"code": c})).text
    # an organisation from before the coupon started isn't new
    await _admin_sql("UPDATE organisations SET created_at = now() - interval '1 day' WHERE id = $1", org)
    await sql("UPDATE coupons SET created_at = now() - interval '1 hour' WHERE code = $1", c)
    assert "new businesses only" in (await owner.post(f"/orgs/{org}/coupon", json={"code": c})).text
    await _admin_sql("UPDATE organisations SET created_at = now() WHERE id = $1", org)
    r = await owner.post(f"/orgs/{org}/coupon", json={"code": c})
    assert r.status_code == 200, r.text
    assert (await owner.get(f"/orgs/{org}/plan")).json()["plan"]["code"] == "growth"
    # one of each kind: a second free-plan coupon is refused, a different kind is fine
    t = code("TRY")
    await staff.post("/staff/coupons", json={"code": t, "kind": "free_plan", "plan": "scale", "months": 1})
    assert "of this kind" in (await owner.post(f"/orgs/{org}/coupon", json={"code": t})).text
    # used: the offer can't change any more, and it can't be deleted
    rows = (await staff.get("/staff/coupons")).json()
    used = next(x for x in rows if x["code"] == c)
    assert used["uses"] == 1 and used["used_by"][0]["org_id"] == org
    body = {k: used[k] for k in ("kind", "plan", "months", "industries", "who", "signup_days", "emails", "domains",
                                 "max_uses", "note")}
    assert (await staff.put(f"/staff/coupons/{c}", json={**body, "months": 2})).status_code == 409
    assert (await staff.put(f"/staff/coupons/{c}", json={**body, "note": "only the note changes"})).status_code == 200
    assert (await staff.delete(f"/staff/coupons/{c}")).status_code == 409
    csv_ = await staff.get(f"/staff/coupons/{c}/uses.csv")
    assert csv_.status_code == 200 and csv_.headers["content-type"].startswith("text/csv") and "kitchens.in" in csv_.text


async def test_extra_trial_days_and_ai_tokens(client, staff):
    trial, tokens = code("TRIAL"), code("AI")
    await staff.post("/staff/coupons", json={"code": trial, "kind": "trial_days", "days": 30})
    await staff.post("/staff/coupons", json={"code": tokens, "kind": "ai_tokens", "tokens": 250000, "months": 2,
                                             "who": "anyone"})
    owner = await make_actor(client, "trial-owner")
    org = await _org(owner)
    q = "SELECT private.trial_end($1) AS t"
    before = (await sql(q, uuid.UUID(org)))[0]["t"]
    assert (await owner.post(f"/orgs/{org}/coupon", json={"code": trial})).status_code == 200
    gained = (await sql(q, uuid.UUID(org)))[0]["t"] - before
    assert timedelta(days=29) < gained <= timedelta(days=30, minutes=1)
    assert (await owner.post(f"/orgs/{org}/coupon", json={"code": tokens})).status_code == 200
    plan = (await owner.get(f"/orgs/{org}/plan")).json()
    assert plan["bonus_tokens"] == 250000
    if plan["plan"]["monthly_tokens"] is not None:
        assert plan["tokens_left"] == plan["plan"]["monthly_tokens"] + 250000 - plan["tokens"]
    mine = (await owner.get(f"/orgs/{org}/coupon")).json()
    assert {x["kind"] for x in mine["coupons"]} == {"trial_days", "ai_tokens"} and mine["code"] is None


def charged(org: str, paise: int, eid: str, coupon: str | None) -> tuple[bytes, dict]:
    notes = {"org_id": org, **({"coupon": coupon} if coupon else {})}
    body = json.dumps({"event": "subscription.charged", "payload": {
        "subscription": {"entity": {"id": "sub_c1", "plan_id": "plan_P", "status": "active",
                                    "current_end": int(time.time()) + 30 * 86400, "notes": notes}},
        "payment": {"entity": {"id": f"pay_{eid}", "amount": paise, "notes": notes}}}}).encode()
    return body, {"x-razorpay-signature": hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest(),
                  "x-razorpay-event-id": eid, "content-type": "application/json"}


async def test_percent_off_rides_on_the_subscription(client, monkeypatch, staff):
    seen = _configure(monkeypatch)
    pc = code("SAVE")
    r = await staff.post("/staff/coupons", json={"code": pc, "kind": "percent_off", "percent": 20,
                                                 "razorpay_offer_id": "offer_GROWTH20x", "plans": ["growth"],
                                                 "periods": ["monthly"], "months": 3, "who": "anyone"})
    assert r.status_code == 201, r.text
    owner = await make_actor(client, "pct-owner")
    org = await _org(owner)
    assert (await owner.post(f"/orgs/{org}/coupon", json={"code": pc})).status_code == 200
    # not for Starter: no offer
    assert (await owner.post(f"/orgs/{org}/billing/subscribe", json={"plan": "starter"})).status_code == 200
    assert "offer_id" not in seen[-1][2]
    assert (await owner.post(f"/orgs/{org}/billing/subscribe", json={"plan": "growth"})).status_code == 200
    assert seen[-1][2]["offer_id"] == "offer_GROWTH20x" and seen[-1][2]["notes"]["coupon"] == pc
    # ₹6,999 less 20% is accepted only for a subscription made with the coupon
    low = 6999 * 80
    body, h = charged(org, low, f"e{uuid.uuid4().hex[:8]}", None)
    await client.post("/public/billing/razorpay", content=body, headers=h)
    assert (await owner.get(f"/orgs/{org}/plan")).json()["plan"]["code"] != "growth"
    body, h = charged(org, low, f"e{uuid.uuid4().hex[:8]}", pc)
    assert (await client.post("/public/billing/razorpay", content=body, headers=h)).status_code == 200
    assert (await owner.get(f"/orgs/{org}/plan")).json()["plan"]["code"] == "growth"
    mine = (await owner.get(f"/orgs/{org}/coupon")).json()["coupons"]
    assert mine[0]["used"] is True
    # used once: a new subscription doesn't get the offer again
    await owner.post(f"/orgs/{org}/billing/subscribe", json={"plan": "growth"})
    assert "offer_id" not in seen[-1][2] or seen[-1][2]["offer_id"] != "offer_GROWTH20x"
