"""DPDP self-service: export your data; delete your account (and close an org you own alone)."""
from __future__ import annotations

import uuid

import asyncpg
import pytest

from conftest import ADMIN_DSN, make_actor


async def test_export_has_profile_and_memberships(world):
    alice = world["alice"]
    data = (await alice.get("/auth/me/export")).json()
    assert data["profile"]["email"] == alice.email
    assert data["memberships"] and all("role" in m for m in data["memberships"])


async def test_terms_acceptance_is_recorded(client):
    from kritvia_api.config import get_settings
    current = get_settings().terms_version
    me = await make_actor(client, "terms")
    assert (await me.get("/auth/me")).json()["terms_version"] is None
    assert (await me.get("/auth/me")).json()["terms_current"] == current
    assert (await me.post("/auth/me/terms", json={"version": "2001-01-01"})).status_code == 409
    # under-18s are refused: the age confirmation is required with the acceptance
    assert (await me.post("/auth/me/terms", json={"version": current})).status_code == 422
    assert (await me.post("/auth/me/terms", json={"version": current, "adult": False})).status_code == 422
    assert (await me.get("/auth/me")).json()["terms_version"] is None
    assert (await me.post("/auth/me/terms", json={"version": current, "adult": True})).status_code == 204
    assert (await me.get("/auth/me")).json()["terms_version"] == current
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        row = await conn.fetchrow("SELECT terms_accepted_at, adult_confirmed_at FROM users WHERE id = $1", me.id)
        assert row["terms_accepted_at"] is not None and row["adult_confirmed_at"] is not None
    finally:
        await conn.close()
    profile = (await me.get("/auth/me/export")).json()["profile"]
    assert profile["terms_version"] == current and profile["adult_confirmed_at"]


async def test_delete_account_closes_solo_org_and_anonymises(client, monkeypatch):
    from kritvia_api.config import get_settings
    monkeypatch.setattr(get_settings(), "vapid_public_key", "BPUBLIC")
    monkeypatch.setattr(get_settings(), "vapid_private_key", "private")
    solo = await make_actor(client, "solo")
    org = (await solo.post("/orgs", json={"name": "Solo Co", "slug": "solo-" + uuid.uuid4().hex[:8]})).json()["id"]
    await solo.post(f"/orgs/{org}/ventures", json={"name": "Shop", "slug": "shop"})
    sub = {"endpoint": f"https://fcm.googleapis.com/fcm/send/{uuid.uuid4().hex}", "keys": {"p256dh": "k", "auth": "a"}}
    assert (await solo.post("/me/push", json=sub)).status_code == 201
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
        pushes = await conn.fetchval("SELECT count(*) FROM push_subscriptions WHERE user_id = $1", solo.id)
    finally:
        await conn.close()
    assert u["email"].endswith("@deleted.invalid") and u["full_name"] == "Deleted user" and not u["is_active"]
    assert closed is not None and members == 0 and pushes == 0
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


async def test_support_messages_are_purged_after_two_years():
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        old = await conn.fetchval("INSERT INTO support_requests (name, email, topic, message, created_at) VALUES "
                                  "('Old', 'old@example.com', 'question', 'an old question', now() - interval '731 days')"
                                  " RETURNING id")
        new = await conn.fetchval("INSERT INTO support_requests (name, email, topic, message) VALUES "
                                  "('New', 'new@example.com', 'question', 'a new question') RETURNING id")
        assert await conn.fetchval("SELECT private.purge_support(730)") >= 1
        left = {r["id"] for r in await conn.fetch("SELECT id FROM support_requests WHERE id = ANY($1)", [old, new])}
    finally:
        await conn.close()
    assert left == {new}


async def test_closed_org_can_be_restored_for_a_new_owner_account(client):
    owner = await make_actor(client, "restore-me")
    org = (await owner.post("/orgs", json={"name": "Restore Co", "slug": "rs-" + uuid.uuid4().hex[:8]})).json()["id"]
    assert (await owner.post("/auth/me/delete", json={"confirm": "DELETE"})).status_code == 200
    again = await client.post("/auth/register", json={"email": owner.email, "full_name": "Back", "password": "a long password 9"})
    assert again.status_code == 201
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        uid = await conn.fetchval("SELECT private.restore_org($1, $2)", uuid.UUID(org), owner.email.upper())
        closed = await conn.fetchval("SELECT closed_at FROM organisations WHERE id = $1", uuid.UUID(org))
        role = await conn.fetchval("SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2", uuid.UUID(org), uid)
        with pytest.raises(asyncpg.RaiseError):
            await conn.fetchval("SELECT private.restore_org($1, $2)", uuid.UUID(org), owner.email)   # not closed now
    finally:
        await conn.close()
    assert closed is None and role == "org_owner"
