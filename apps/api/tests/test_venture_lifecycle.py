"""Owners add, rename, remove and restore their businesses; removed data is erased after 30 days."""
from __future__ import annotations

import uuid

import asyncpg

from conftest import ADMIN_DSN, join, make_actor


async def _org(client):
    owner = await make_actor(client, "bizowner")
    org = (await owner.post("/orgs", json={"name": "Biz Co", "slug": "biz-" + uuid.uuid4().hex[:8]})).json()["id"]
    a = await owner.post(f"/orgs/{org}/ventures", json={"name": "Studio", "slug": "studio", "kind": "software"})
    b = await owner.post(f"/orgs/{org}/ventures", json={"name": "Kitchen", "slug": "kitchen", "kind": "kitchen"})
    assert a.status_code == 201 and b.status_code == 201, (a.text, b.text)
    return owner, org, a.json()["id"], b.json()["id"]


async def test_add_rename_and_who_may(client):
    owner, org, studio, kitchen = await _org(client)
    listed = {v["name"]: v["kind"] for v in (await owner.get(f"/orgs/{org}/ventures")).json()}
    assert listed == {"Studio": "software", "Kitchen": "kitchen"}

    r = await owner.patch(f"/orgs/{org}/ventures/{studio}", json={"name": "  Sitelytc Studio  "})
    assert r.status_code == 200 and r.json()["name"] == "Sitelytc Studio", r.text
    assert (await owner.patch(f"/orgs/{org}/ventures/{studio}", json={"name": ""})).status_code == 422
    access = (await owner.get("/me/access")).json()["ventures"]
    assert "Sitelytc Studio" in {v["venture_name"] for v in access}

    staff = await make_actor(client, "bizstaff")
    await join(owner, staff, org, studio, "operator")
    assert (await staff.patch(f"/orgs/{org}/ventures/{studio}", json={"name": "Mine"})).status_code == 404
    assert (await staff.post(f"/orgs/{org}/ventures/{studio}/remove", json={"confirm": "Sitelytc Studio"})).status_code == 404
    outsider = await make_actor(client, "bizoutsider")
    assert (await outsider.patch(f"/orgs/{org}/ventures/{studio}", json={"name": "x"})).status_code == 404


async def test_remove_hides_stops_and_restores(client):
    owner, org, studio, kitchen = await _org(client)
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute("INSERT INTO connectors (org_id, venture_id, provider, status) VALUES ($1, $2, 'google', 'active')",
                           uuid.UUID(org), uuid.UUID(kitchen))
        await conn.execute("INSERT INTO workflow_configs (org_id, venture_id, workflow, enabled) VALUES ($1, $2, 'inbox_assistant', true)"
                           " ON CONFLICT DO NOTHING", uuid.UUID(org), uuid.UUID(kitchen))

        r = await owner.post(f"/orgs/{org}/ventures/{kitchen}/remove", json={"confirm": "Kitchn"})
        assert r.status_code == 409 and "type the business name" in r.text
        r = await owner.post(f"/orgs/{org}/ventures/{kitchen}/remove", json={"confirm": " kitchen "})
        assert r.status_code == 204, r.text

        # gone from every view, and its data is unreadable
        assert [v["name"] for v in (await owner.get(f"/orgs/{org}/ventures")).json()] == ["Studio"]
        assert kitchen not in {v["venture_id"] for v in (await owner.get("/me/access")).json()["ventures"]}
        assert (await owner.get(f"/ventures/{kitchen}/settings")).status_code == 404
        assert (await owner.get(f"/orgs/{org}/plan")).json()["ventures"] == 1
        # agents and connectors stopped
        assert await conn.fetchval("SELECT status FROM connectors WHERE venture_id = $1", uuid.UUID(kitchen)) == "revoked"
        assert not await conn.fetchval("SELECT bool_or(enabled) FROM workflow_configs WHERE venture_id = $1",
                                       uuid.UUID(kitchen))

        removed = (await owner.get(f"/orgs/{org}/ventures/removed")).json()
        assert [x["name"] for x in removed] == ["Kitchen"] and removed[0]["erase_after"] > removed[0]["removed_at"]

        # the only business left cannot be removed
        r = await owner.post(f"/orgs/{org}/ventures/{studio}/remove", json={"confirm": "Studio"})
        assert r.status_code == 409 and "only business" in r.text

        # restore within 30 days: visible again, agents still off
        assert (await owner.post(f"/orgs/{org}/ventures/{kitchen}/restore")).status_code == 200
        assert {v["name"] for v in (await owner.get(f"/orgs/{org}/ventures")).json()} == {"Studio", "Kitchen"}
        assert (await owner.get(f"/ventures/{kitchen}/settings")).status_code == 200
        assert not await conn.fetchval("SELECT bool_or(enabled) FROM workflow_configs WHERE venture_id = $1",
                                       uuid.UUID(kitchen))
        assert (await owner.get(f"/orgs/{org}/ventures/removed")).json() == []
    finally:
        await conn.close()


async def test_removed_business_is_erased_after_30_days(client):
    owner, org, studio, kitchen = await _org(client)
    assert (await owner.post(f"/orgs/{org}/ventures/{kitchen}/remove", json={"confirm": "Kitchen"})).status_code == 204
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.fetchval("SELECT private.purge_removed_ventures(30)")   # a fresh removal is kept
        assert await conn.fetchval("SELECT count(*) FROM ventures WHERE id = $1", uuid.UUID(kitchen)) == 1
        await conn.execute("UPDATE ventures SET removed_at = now() - interval '31 days' WHERE id = $1", uuid.UUID(kitchen))
        assert await conn.fetchval("SELECT private.purge_removed_ventures(30)") >= 1
        assert await conn.fetchval("SELECT count(*) FROM ventures WHERE id = $1", uuid.UUID(kitchen)) == 0
        assert await conn.fetchval("SELECT count(*) FROM ventures WHERE id = $1", uuid.UUID(studio)) == 1
    finally:
        await conn.close()
    assert (await owner.post(f"/orgs/{org}/ventures/{kitchen}/restore")).status_code == 404
