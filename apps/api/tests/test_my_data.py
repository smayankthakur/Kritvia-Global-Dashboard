"""DPDP self-service: export your data; delete your account (and close an org you own alone)."""
from __future__ import annotations

import uuid

import asyncpg

from conftest import ADMIN_DSN, make_actor


async def test_export_has_profile_and_memberships(world):
    alice = world["alice"]
    data = (await alice.get("/auth/me/export")).json()
    assert data["profile"]["email"] == alice.email
    assert data["memberships"] and all("role" in m for m in data["memberships"])


async def test_delete_account_closes_solo_org_and_anonymises(client):
    solo = await make_actor(client, "solo")
    org = (await solo.post("/orgs", json={"name": "Solo Co", "slug": "solo-" + uuid.uuid4().hex[:8]})).json()["id"]
    await solo.post(f"/orgs/{org}/ventures", json={"name": "Shop", "slug": "shop"})
    assert (await solo.post("/auth/me/delete", json={"confirm": "yes"})).status_code == 422
    r = await solo.post("/auth/me/delete", json={"confirm": "DELETE"})
    assert r.status_code == 200 and r.json()["organisations_closed"] == 1
    # signed out everywhere, and the address is free to sign up again
    assert (await solo.get("/auth/me")).status_code == 401
    assert (await client.post("/auth/login", json={"email": solo.email, "password": "correct horse battery"})).status_code == 401
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        u = await conn.fetchrow("SELECT email, full_name, is_active FROM users WHERE id = $1", solo.id)
        closed = await conn.fetchval("SELECT closed_at FROM organisations WHERE id = $1", uuid.UUID(org))
        members = await conn.fetchval("SELECT count(*) FROM memberships WHERE user_id = $1", solo.id)
    finally:
        await conn.close()
    assert u["email"].endswith("@deleted.invalid") and u["full_name"] == "Deleted user" and not u["is_active"]
    assert closed is not None and members == 0
    again = await client.post("/auth/register", json={"email": solo.email, "full_name": "New", "password": "a long password 9"})
    assert again.status_code == 201


async def test_owner_with_team_must_hand_over_first(world):
    r = await world["mayank"].post("/auth/me/delete", json={"confirm": "DELETE"})
    assert r.status_code == 409 and "owner" in r.json()["detail"]
    assert (await world["mayank"].get("/auth/me")).status_code == 200


async def test_closed_org_is_purged_after_grace_period(client):
    solo = await make_actor(client, "gone")
    org = (await solo.post("/orgs", json={"name": "Gone Co", "slug": "gone-" + uuid.uuid4().hex[:8]})).json()["id"]
    await solo.post(f"/orgs/{org}/ventures", json={"name": "Shop", "slug": "shop"})
    await solo.post("/auth/me/delete", json={"confirm": "DELETE"})
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        assert await conn.fetchval("SELECT private.purge_closed_orgs(30)") >= 0
        assert await conn.fetchval("SELECT count(*) FROM organisations WHERE id = $1", uuid.UUID(org)) == 1  # grace
        await conn.execute("UPDATE organisations SET closed_at = now() - interval '31 days' WHERE id = $1", uuid.UUID(org))
        assert await conn.fetchval("SELECT private.purge_closed_orgs(30)") >= 1
        assert await conn.fetchval("SELECT count(*) FROM organisations WHERE id = $1", uuid.UUID(org)) == 0
        assert await conn.fetchval("SELECT count(*) FROM ventures WHERE org_id = $1", uuid.UUID(org)) == 0
    finally:
        await conn.close()
