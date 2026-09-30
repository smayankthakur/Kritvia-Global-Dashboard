"""Exit criterion: every write appears in the audit log, and the log is
tamper-evident."""
from __future__ import annotations

import asyncio

import asyncpg
import pytest

from conftest import ADMIN_DSN, TEST_DB, make_actor

pytestmark = pytest.mark.asyncio


async def _audit(actor, org, **params):
    return (await actor.get(f"/orgs/{org}/audit", params=params | {"limit": 500})).json()


async def test_every_write_is_audited(world):
    mayank, alice, org, site = world["mayank"], world["alice"], world["org"], world["site"]
    lead = (await alice.post(f"/ventures/{site}/leads",
                             json={"name": "Audit Co", "notes": "SECRET-NOTE-123"})).json()
    await alice.patch(f"/ventures/{site}/leads/{lead['id']}", json={"status": "qualified", "score": 80})
    await alice.delete(f"/ventures/{site}/leads/{lead['id']}")

    entries = [e for e in await _audit(mayank, org) if e["entity_id"] == lead["id"]]
    actions = [e["action"] for e in sorted(entries, key=lambda e: e["seq"])]
    assert actions == ["leads.insert", "leads.update", "leads.delete"]
    assert all(e["actor_user_id"] == str(alice.id) for e in entries)

    update = next(e for e in entries if e["action"] == "leads.update")
    assert {"score", "status", "updated_at"} <= set(update["details"]["columns"])
    # Values never enter the log — only column names.
    assert "SECRET-NOTE-123" not in str(entries) and "qualified" not in str(update["details"])


async def test_tenancy_changes_are_audited(world):
    actions = {e["action"] for e in await _audit(world["mayank"], world["org"])}
    assert {"organisations.insert", "ventures.insert", "memberships.insert", "grants.insert"} <= actions


async def test_venture_member_sees_only_their_venture_audit(world):
    entries = await _audit(world["alice"], world["org"])
    assert entries and all(e["venture_id"] == world["site"] for e in entries)


async def test_chain_verifies(world):
    r = (await world["mayank"].get(f"/orgs/{world['org']}/audit/verify")).json()
    assert r == {"org_id": world["org"], "intact": True, "first_broken_seq": None}


async def test_app_role_cannot_modify_audit_log(world):
    conn = await asyncpg.connect(f"postgresql://kritvia_app:app@localhost/{TEST_DB}")
    try:
        for stmt in ("UPDATE audit_log SET action = 'x'", "DELETE FROM audit_log",
                     "TRUNCATE audit_log",
                     "INSERT INTO audit_log (org_id, seq, actor_type, action, row_hash)"
                     " VALUES (gen_random_uuid(), 1, 'user', 'forged', '')"):
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await conn.execute(stmt)
    finally:
        await conn.close()


async def test_owner_role_cannot_rewrite_history(world):
    conn = await asyncpg.connect(f"postgresql://kritvia_owner:owner@localhost/{TEST_DB}")
    try:
        with pytest.raises(asyncpg.RaiseError, match="append-only"):
            await conn.execute("UPDATE audit_log SET action = 'x' WHERE org_id = $1", world["org"])
    finally:
        await conn.close()


async def test_concurrent_writes_keep_chain_contiguous(client):
    owner = await make_actor(client, "burst")
    org = (await owner.post("/orgs", json={"name": "Burst", "slug": f"burst-{owner.id.hex[:6]}"})).json()["id"]
    v = (await owner.post(f"/orgs/{org}/ventures", json={"name": "K", "slug": "kitchen"})).json()["id"]
    results = await asyncio.gather(*[
        owner.post(f"/ventures/{v}/leads", json={"name": f"lead {i}"}) for i in range(25)])
    assert all(r.status_code == 201 for r in results)

    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        seqs = [r["seq"] for r in await conn.fetch(
            "SELECT seq FROM audit_log WHERE org_id = $1 ORDER BY seq", org)]
        assert seqs == list(range(1, len(seqs) + 1))
        assert await conn.fetchval("SELECT private.audit_verify($1)", org) is None
    finally:
        await conn.close()


async def test_tampering_is_detected(client):
    """A superuser who disables the trigger and edits a row is caught by verify."""
    owner = await make_actor(client, "tamper")
    org = (await owner.post("/orgs", json={"name": "T", "slug": f"tamper-{owner.id.hex[:6]}"})).json()["id"]
    v = (await owner.post(f"/orgs/{org}/ventures", json={"name": "V", "slug": "venture-v"})).json()["id"]
    for i in range(3):
        await owner.post(f"/ventures/{v}/leads", json={"name": f"L{i}"})

    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute("ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update")
        await conn.execute("UPDATE audit_log SET action = 'leads.nothing_to_see' WHERE org_id = $1 AND seq = 4",
                           org)
        await conn.execute("ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update")
    finally:
        await conn.close()

    r = (await owner.get(f"/orgs/{org}/audit/verify")).json()
    assert r["intact"] is False and r["first_broken_seq"] == 4
