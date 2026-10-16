"""Coupons: FIRST50 gives the Scale plan free for 3 months to the first 50 organisations; once per
organisation and per person; a paid plan wins; afterwards back to Free with 7 days to choose."""
from __future__ import annotations

import uuid

import pytest

from conftest import ADMIN_DSN, join, make_actor
from kritvia_api.config import get_settings

pytestmark = pytest.mark.asyncio


async def _org(actor, name="Coupon Co"):
    r = await actor.post("/orgs", json={"name": name, "slug": f"cp-{uuid.uuid4().hex[:8]}"})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _admin_sql(sql: str, *args) -> None:
    import asyncpg
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute(sql, *[uuid.UUID(a) if isinstance(a, str) else a for a in args])
    finally:
        await conn.close()


async def test_first50_gives_scale_for_three_months(client, monkeypatch, world):
    monkeypatch.setattr(get_settings(), "default_plan", "free")
    await _admin_sql("UPDATE coupons SET uses = 0, max_uses = 50, active = true WHERE code = 'FIRST50'")
    await _admin_sql("DELETE FROM coupon_redemptions WHERE code = 'FIRST50'")

    info = (await client.get("/public/coupons/first50")).json()
    assert info == {"code": "FIRST50", "plan": "scale", "plan_name": "Scale", "months": 3, "places_left": 50,
                    "open": True, "offer": "Scale plan free for 3 months"}
    assert (await client.get("/public/coupons/NOPE1")).status_code == 404

    owner = await make_actor(client, "cp-owner")
    org = await _org(owner)
    assert (await owner.get(f"/orgs/{org}/plan")).json()["plan"]["code"] == "free"
    assert (await owner.get(f"/orgs/{org}/coupon")).json()["code"] is None

    # only the owner can apply it
    member = await make_actor(client, "cp-member")
    v = (await owner.post(f"/orgs/{org}/ventures", json={"name": "Shop", "slug": f"shop-{uuid.uuid4().hex[:6]}"})).json()["id"]
    await join(owner, member, org, v, "venture_admin")
    assert (await member.post(f"/orgs/{org}/coupon", json={"code": "FIRST50"})).status_code == 404
    assert (await owner.post(f"/orgs/{org}/coupon", json={"code": "WRONG1"})).status_code == 404

    r = await owner.post(f"/orgs/{org}/coupon", json={"code": "first50"})
    assert r.status_code == 200, r.text
    assert r.json()["running"] is True and r.json()["plan"] == "scale"
    plan = (await owner.get(f"/orgs/{org}/plan")).json()
    assert plan["plan"]["code"] == "scale" and plan["read_only"] is False
    assert (await member.get(f"/orgs/{org}/coupon")).json()["code"] == "FIRST50"     # members can see it
    assert (await client.get("/public/coupons/FIRST50")).json()["places_left"] == 49

    # once per organisation
    assert (await owner.post(f"/orgs/{org}/coupon", json={"code": "FIRST50"})).status_code == 409

    # when the free months end: back to Free, 7 days to choose a plan, then read-only
    await _admin_sql("UPDATE coupon_redemptions SET ends_at = now() - interval '1 day' WHERE org_id = $1", org)
    await _admin_sql("UPDATE organisations SET trial_ends_at = now() - interval '90 days' WHERE id = $1", org)
    monkeypatch.setattr(get_settings(), "payments_live_at", None)
    plan = (await owner.get(f"/orgs/{org}/plan")).json()
    assert plan["plan"]["code"] == "free" and plan["read_only"] is False
    st = (await owner.get(f"/orgs/{org}/coupon")).json()
    assert st["running"] is False and st["code"] == "FIRST50"
    await _admin_sql("UPDATE coupon_redemptions SET ends_at = now() - interval '8 days' WHERE org_id = $1", org)
    from datetime import UTC, datetime, timedelta
    monkeypatch.setattr(get_settings(), "payments_live_at", datetime.now(UTC) - timedelta(days=30))
    assert (await owner.get(f"/orgs/{org}/plan")).json()["read_only"] is True

    # once per person: even after paying for the first organisation, a second one can't take it again
    await _admin_sql("INSERT INTO org_plans (org_id, plan) VALUES ($1, 'starter')"
                     " ON CONFLICT (org_id) DO UPDATE SET plan = 'starter'", org)
    org2 = await _org(owner, "Second Co")
    r2 = await owner.post(f"/orgs/{org2}/coupon", json={"code": "FIRST50"})
    assert r2.status_code == 409 and "another organisation" in r2.json()["detail"]
    assert (await owner.get(f"/orgs/{org}/coupon")).json()["superseded"] is True


async def test_places_run_out_and_paid_plans_win(client, monkeypatch, world):
    monkeypatch.setattr(get_settings(), "default_plan", "free")
    await _admin_sql("INSERT INTO coupons (code, plan, months, max_uses) VALUES ('TWOONLY', 'growth', 1, 2)"
               " ON CONFLICT (code) DO UPDATE SET uses = 0, max_uses = 2, active = true")
    await _admin_sql("DELETE FROM coupon_redemptions WHERE code = 'TWOONLY'")
    used = []
    for i in range(2):
        a = await make_actor(client, f"cp-two-{i}")
        o = await _org(a)
        assert (await a.post(f"/orgs/{o}/coupon", json={"code": "TWOONLY"})).status_code == 200
        used.append(o)
    late = await make_actor(client, "cp-late")
    lo = await _org(late)
    r = await late.post(f"/orgs/{lo}/coupon", json={"code": "TWOONLY"})
    assert r.status_code == 409 and "taken" in r.json()["detail"]
    assert (await client.get("/public/coupons/TWOONLY")).json()["open"] is False

    # a paid plan wins over a running coupon
    await _admin_sql("INSERT INTO org_plans (org_id, plan) VALUES ($1, 'starter')"
               " ON CONFLICT (org_id) DO UPDATE SET plan = 'starter'", used[0])
    a0 = await make_actor(client, "cp-paid")   # someone else can't see it
    assert (await a0.get(f"/orgs/{used[0]}/coupon")).status_code == 404

    # a paid organisation can't take a coupon
    p = await make_actor(client, "cp-already-paid")
    po = await _org(p)
    await _admin_sql("INSERT INTO org_plans (org_id, plan) VALUES ($1, 'growth') ON CONFLICT (org_id) DO UPDATE SET plan = 'growth'", po)
    await _admin_sql("UPDATE coupons SET max_uses = 3 WHERE code = 'TWOONLY'")
    assert (await p.post(f"/orgs/{po}/coupon", json={"code": "TWOONLY"})).status_code == 409


async def test_staff_view(client, monkeypatch, world):
    staff = world["mayank"]
    assert (await staff.get("/staff/coupons")).status_code == 404
    monkeypatch.setattr(get_settings(), "staff_emails", staff.email)
    rows = (await staff.get("/staff/coupons")).json()
    first = next(c for c in rows if c["code"] == "FIRST50")
    assert first["offer"] == "Scale plan free for 3 months" and first["max_uses"] == 50
    r = await staff.patch("/staff/coupons/FIRST50", json={"active": False})
    assert next(c for c in r.json() if c["code"] == "FIRST50")["active"] is False
    assert (await client.get("/public/coupons/FIRST50")).json()["open"] is False
    await staff.patch("/staff/coupons/FIRST50", json={"active": True})
