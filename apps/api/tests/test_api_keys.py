"""API keys (Scale and Enterprise): made by owners, shown once, limited to the organisation, a few
endpoints and their scope; refused when the plan doesn't include API access; revoked at once.
Also: priority processing picks the reserved queue only for plans that include it."""
from __future__ import annotations

import uuid

import asyncpg
import pytest

from conftest import ADMIN_DSN, join, make_actor
from kritvia_api.config import get_settings

pytestmark = pytest.mark.asyncio


async def _sql(sql: str, *args) -> None:
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute(sql, *args)
    finally:
        await conn.close()


async def _plan(org: str, plan: str) -> None:
    await _sql("INSERT INTO org_plans (org_id, plan) VALUES ($1, $2) ON CONFLICT (org_id) DO UPDATE SET plan = $2",
               uuid.UUID(org), plan)


async def test_keys(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "default_plan", "free")
    owner = await make_actor(client, "key-owner")
    org = (await owner.post("/orgs", json={"name": "Keys Co", "slug": f"k-{uuid.uuid4().hex[:8]}"})).json()["id"]
    v = (await owner.post(f"/orgs/{org}/ventures", json={"name": "Shop", "slug": f"k-{uuid.uuid4().hex[:6]}"})).json()["id"]
    member = await make_actor(client, "key-member")
    await join(owner, member, org, v, "venture_admin")

    lst = (await owner.get(f"/orgs/{org}/api-keys")).json()
    assert lst["available"] is False and lst["keys"] == []
    assert (await owner.post(f"/orgs/{org}/api-keys", json={"name": "Zapier"})).status_code == 402
    await _plan(org, "scale")
    assert (await member.post(f"/orgs/{org}/api-keys", json={"name": "Mine"})).status_code == 404

    r = await owner.post(f"/orgs/{org}/api-keys", json={"name": "Website", "scope": "write"})
    assert r.status_code == 201, r.text
    key = r.json()["key"]
    assert key.startswith("kvk_") and r.json()["prefix"] == key[:12]
    ro = (await owner.post(f"/orgs/{org}/api-keys", json={"name": "Reports"})).json()
    assert "key" not in (await owner.get(f"/orgs/{org}/api-keys")).json()["keys"][0]

    h = {"Authorization": f"Bearer {key}"}
    hr = {"Authorization": f"Bearer {ro['key']}"}
    # write: add a lead and an invoice; read them back
    lead = await client.post(f"/ventures/{v}/leads", json={"name": "Neha", "email": "neha@example.com"}, headers=h)
    assert lead.status_code == 201, lead.text
    assert (await client.get(f"/ventures/{v}/leads", headers=hr)).json()[0]["name"] == "Neha"
    inv = await client.post(f"/ventures/{v}/invoices", json={"customer_name": "Neha", "amount_paise": 99900, "due_on": "2026-12-01"}, headers=h)
    assert inv.status_code == 201, inv.text
    assert (await client.get(f"/ventures/{v}/analytics", headers=hr)).status_code == 200
    assert (await client.get(f"/orgs/{org}/ventures", headers=hr)).status_code == 200
    # read-only key can't write; nobody can reach other endpoints with a key
    assert (await client.post(f"/ventures/{v}/leads", json={"name": "X"}, headers=hr)).status_code == 403
    assert (await client.delete(f"/ventures/{v}/leads/{lead.json()['id']}", headers=h)).status_code == 403
    assert (await client.get(f"/orgs/{org}/api-keys", headers=h)).status_code == 403
    assert (await client.get("/auth/me", headers=h)).status_code == 403
    assert (await client.get(f"/orgs/{org}/billing", headers=h)).status_code == 403
    # not another organisation's business, even one the owner belongs to
    other = (await owner.post("/orgs", json={"name": "Other", "slug": f"o-{uuid.uuid4().hex[:8]}"}))
    if other.status_code == 201:
        ov = (await owner.post(f"/orgs/{other.json()['id']}/ventures", json={"name": "O", "slug": f"o-{uuid.uuid4().hex[:6]}"})).json()["id"]
        assert (await client.get(f"/ventures/{ov}/leads", headers=hr)).status_code == 404
    assert (await client.get(f"/ventures/{uuid.uuid4()}/leads", headers=hr)).status_code == 404
    assert (await client.get(f"/ventures/{v}/leads", headers={"Authorization": "Bearer kvk_" + "x" * 43})).status_code == 401

    # plan without API access: refused; back on Scale: works; revoked: refused
    await _plan(org, "growth")
    assert (await client.get(f"/ventures/{v}/leads", headers=hr)).status_code == 402
    await _plan(org, "scale")
    assert (await client.get(f"/ventures/{v}/leads", headers=hr)).status_code == 200
    assert (await owner.delete(f"/orgs/{org}/api-keys/{ro['id']}")).status_code == 204
    assert (await client.get(f"/ventures/{v}/leads", headers=hr)).status_code == 401
    keys = (await owner.get(f"/orgs/{org}/api-keys")).json()["keys"]
    assert any(k["revoked_at"] for k in keys) and any(k["last_used_at"] for k in keys)


async def test_priority_queue_choice(client, monkeypatch):
    from kritvia_api.engine.dispatch import run_has_priority
    owner = await make_actor(client, "prio-owner")
    org = (await owner.post("/orgs", json={"name": "Prio Co", "slug": f"p-{uuid.uuid4().hex[:8]}"})).json()["id"]
    v = (await owner.post(f"/orgs/{org}/ventures", json={"name": "Prio", "slug": f"p-{uuid.uuid4().hex[:6]}"})).json()["id"]
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        run = await conn.fetchval(
            "INSERT INTO workflow_runs (org_id, venture_id, workflow, current_step, run_as, status)"   # finished: no sweeper picks it up
            " VALUES ($1, $2, 'inbox_assistant', 'classify', $3, 'completed') RETURNING id", uuid.UUID(org), uuid.UUID(v), owner.id)
        for plan, expected in (("growth", False), ("scale", True), ("enterprise", True), ("internal", True), ("starter", False)):
            await conn.execute("INSERT INTO org_plans (org_id, plan) VALUES ($1, $2)"
                               " ON CONFLICT (org_id) DO UPDATE SET plan = $2", uuid.UUID(org), plan)
            assert await run_has_priority(run) is expected, plan
    finally:
        await conn.close()


async def test_dispatcher_uses_reserved_queue_only_when_its_worker_is_up(monkeypatch):
    from kritvia_api.engine import dispatch

    class Pool:
        def __init__(self, alive):
            self.alive, self.jobs = alive, []

        async def exists(self, key):
            return 1 if self.alive and key == dispatch.PRIORITY_HEARTBEAT else 0

        async def enqueue_job(self, fn, *args, **kw):
            self.jobs.append(kw.get("_queue_name"))

    async def prio(run_id):
        return True
    monkeypatch.setattr(dispatch, "run_has_priority", prio)
    for alive, queue in ((True, dispatch.PRIORITY_QUEUE), (False, None)):
        d = dispatch.ArqDispatcher("redis://x")
        pool = Pool(alive)

        async def get_pool(pool=pool):
            return pool
        d._get_pool = get_pool
        await d.enqueue_run(uuid.uuid4())
        assert pool.jobs == [queue]
