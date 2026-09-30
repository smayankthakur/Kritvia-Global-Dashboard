"""Exit criterion: a user in Venture A cannot read Venture B's data through ANY
API route — and the database refuses even if application code were wrong."""
from __future__ import annotations

import re
import uuid

import asyncpg
import pytest

from conftest import ADMIN_DSN, TEST_DB

from kritvia_api.main import app

pytestmark = pytest.mark.asyncio


# ---------------------------------------------------------------------------
# Behavioural isolation through the API
# ---------------------------------------------------------------------------
async def test_operator_sees_only_own_venture(world):
    alice, site, tru = world["alice"], world["site"], world["tru"]
    leads = (await alice.get(f"/ventures/{site}/leads")).json()
    assert [l["id"] for l in leads] == [world["a_lead"]]
    assert leads[0]["notes"] == "wants a Next.js rebuild, budget 3L"

    assert (await alice.get(f"/ventures/{tru}/leads")).json() == []
    assert (await alice.get(f"/ventures/{tru}/leads/{world['b_lead']}")).status_code == 404
    ventures = (await alice.get(f"/orgs/{world['org']}/ventures")).json()
    assert [v["id"] for v in ventures] == [site]


async def test_cannot_write_into_other_venture(world):
    alice, tru, b_lead = world["alice"], world["tru"], world["b_lead"]
    assert (await alice.post(f"/ventures/{tru}/leads", json={"name": "sneaky"})).status_code == 404
    assert (await alice.patch(f"/ventures/{tru}/leads/{b_lead}", json={"status": "lost"})).status_code == 404
    assert (await alice.delete(f"/ventures/{tru}/leads/{b_lead}")).status_code == 404
    # Bob's lead is untouched
    lead = (await world["bob"].get(f"/ventures/{tru}/leads/{b_lead}")).json()
    assert lead["status"] == "new"


async def test_cannot_smuggle_venture_via_mismatched_path(world):
    """Alice's own lead id under Truhome's path, and Bob's lead under Sitelytc's."""
    alice = world["alice"]
    assert (await alice.get(f"/ventures/{world['tru']}/leads/{world['a_lead']}")).status_code == 404
    assert (await alice.get(f"/ventures/{world['site']}/leads/{world['b_lead']}")).status_code == 404


async def test_viewer_cannot_write(world):
    vera, site = world["vera"], world["site"]
    assert len((await vera.get(f"/ventures/{site}/leads")).json()) >= 1
    assert (await vera.post(f"/ventures/{site}/leads", json={"name": "x"})).status_code == 404
    assert (await vera.patch(f"/ventures/{site}/leads/{world['a_lead']}", json={"score": 5})).status_code == 404


async def test_outsider_org_sees_nothing(world):
    mal = world["mallory"]
    assert world["org"] not in [o["id"] for o in (await mal.get("/orgs")).json()]
    assert (await mal.get(f"/orgs/{world['org']}/ventures")).json() == []
    assert (await mal.get(f"/ventures/{world['site']}/leads")).json() == []
    assert (await mal.get(f"/orgs/{world['org']}/audit")).json() == []
    assert (await mal.get(f"/orgs/{world['org']}/audit/verify")).status_code == 404
    assert (await mal.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "hijack", "slug": "hijack"})).status_code == 404


async def test_non_owner_cannot_manage_org(world):
    alice, org = world["alice"], world["org"]
    assert (await alice.post(f"/orgs/{org}/ventures", json={"name": "n", "slug": "nope"})).status_code == 404
    r = await alice.post(f"/orgs/{org}/grants", json={
        "user_email": world["alice"].email, "venture_id": world["tru"], "access": "write", "reason": "self"})
    assert r.status_code == 404


async def test_owner_cross_venture_view_is_explicit_grant(world):
    """Mayank sees both ventures only because create_venture wrote explicit grants."""
    mayank = world["mayank"]
    assert len((await mayank.get(f"/ventures/{world['site']}/leads")).json()) >= 1
    assert len((await mayank.get(f"/ventures/{world['tru']}/leads")).json()) >= 1
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        n = await conn.fetchval(
            "SELECT count(*) FROM grants WHERE grantee_user_id = $1 AND reason = 'venture creator'",
            mayank.id)
    finally:
        await conn.close()
    assert n == 2


async def test_grant_and_revoke_read_access(world):
    mayank, alice, org, tru = world["mayank"], world["alice"], world["org"], world["tru"]
    r = await mayank.post(f"/orgs/{org}/grants", json={
        "user_email": alice.email, "venture_id": tru, "access": "read", "reason": "covering for Bob"})
    assert r.status_code == 201
    grant_id = r.json()["id"]

    assert world["b_lead"] in [l["id"] for l in (await alice.get(f"/ventures/{tru}/leads")).json()]
    # read grant does not confer write
    assert (await alice.post(f"/ventures/{tru}/leads", json={"name": "x"})).status_code == 404

    assert (await mayank.delete(f"/orgs/{org}/grants/{grant_id}")).status_code == 204
    assert (await alice.get(f"/ventures/{tru}/leads")).json() == []


async def test_unauthenticated_and_forged_tokens_rejected(client, world):
    assert (await client.get(f"/ventures/{world['site']}/leads")).status_code == 401
    bad = {"Authorization": "Bearer not.a.jwt"}
    assert (await client.get(f"/ventures/{world['site']}/leads", headers=bad)).status_code == 401


# ---------------------------------------------------------------------------
# Exhaustive route sweep: every tenant-scoped route, attacked with foreign IDs
# ---------------------------------------------------------------------------
SAMPLE_BODIES = {
    "/orgs": {"name": "x", "slug": "sweep-org"},
    "/orgs/{org_id}/ventures": {"name": "x", "slug": "sweep"},
    "/orgs/{org_id}/members": {"user_email": "{alice_email}", "role": "viewer", "venture_id": "{tru}"},
    "/orgs/{org_id}/grants": {"user_email": "{alice_email}", "venture_id": "{tru}", "access": "read",
                              "reason": "sweep"},
    "/ventures/{venture_id}/leads": {"name": "sweep"},
    "/ventures/{venture_id}/leads/{lead_id}": {"status": "lost"},
    "/ventures/{venture_id}/settings": {"kind": "software"},
    "/ventures/{venture_id}/runs": {"workflow": "lead_triage", "input": {"body": "x"}},
    "/ventures/{venture_id}/workflow-configs/{workflow}": {"enabled": False},
    "/ventures/{venture_id}/approvals/{approval_id}/decision": {"decision": "approve"},
    "/ventures/{venture_id}/trust/{agent}/{action}": {"auto_run": True, "reason": "sweep"},
    "/ventures/{venture_id}/ask": {"question": "Sharma PAN"},
    "/orgs/{org_id}/ask": {"question": "Sharma PAN"},
    "/ventures/{venture_id}/notes": {"title": "x", "text": "sweep note"},
    "/ventures/{venture_id}/leads/inquiry": {"from_email": "a@b.co", "body": "need a website"},
    "/ventures/{venture_id}/rate-card": {"items": []},
    "/ventures/{venture_id}/checklists/{loan_type}": {"name": "x", "items": [{"doc_type": "pan_card",
                                                                              "label": "PAN"}]},
    "/ventures/{venture_id}/loan-applications": {
        "loan_type": "home_loan", "applicant": {"name": "X", "email": "x@y.co"},
        "consent": {"notice_version": "v1"}},
    "/ventures/{venture_id}/kitchen/run": {},
    "/ventures/{venture_id}/kitchen/ref/{entity}": {"items": [{"code": "x", "name": "x"}]},
    "/ventures/{venture_id}/kitchen/recipes": {"recipes": {}},
    "/ventures/{venture_id}/kitchen/vendor-items": {"items": []},
    "/ventures/{venture_id}/kitchen/events": {"event_date": "2026-10-20", "name": "Diwali"},
    "/ventures/{venture_id}/kitchen/stock": {"counts": []},
    "/ventures/{venture_id}/consents": {"identifier": "x@y.co", "purpose": "loan_processing",
                                        "notice_version": "v1"},
    "/ventures/{venture_id}/dpdp-requests": {"identifier": "x@y.co", "kind": "access"},
    "/ventures/{venture_id}/breaches": {"detected_at": "2026-09-01T00:00:00Z", "summary": "x",
                                        "severity": "low"},
    "/ventures/{venture_id}/retention": {"data_class": "upload", "retain_days": 30},
    "/ventures/{venture_id}/connectors/webhook": {},
    "/ventures/{venture_id}/connectors/google/start": {"nonce": "n" * 40},
    "/orgs/{org_id}/invitations": {"email": "{alice_email}", "role": "viewer", "venture_id": "{tru}"},
}
SELF_SERVICE = {("/orgs", "post"), ("/orgs", "get")}  # not scoped to someone else's IDs
PUBLIC_PREFIXES = ("/hooks/", "/public/", "/connectors/google/complete", "/auth/", "/invitations/accept")
PARAM = re.compile(r"\{([a-z_]+)\}")


def _fill(obj, subs):
    if isinstance(obj, dict):
        return {k: _fill(v, subs) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_fill(v, subs) for v in obj]
    if isinstance(obj, str):
        return obj.format(**subs) if "{" in obj else obj
    return obj


def _empty(body) -> bool:
    if body in ([], {}, None):
        return True
    if isinstance(body, dict):
        return all(_empty(v) or not isinstance(v, list | dict) and k in ("org_id", "status", "intact", "total")
                   for k, v in body.items())
    return False


async def test_every_scoped_route_denies_foreign_ids(world):
    """Alice (Sitelytc only) calls every route with Truhome / other-org IDs.
    Nothing may succeed and no Truhome data may appear in any response."""
    alice = world["alice"]
    subs = {
        "org_id": world["m_org"],           # an org she is not in at all
        "venture_id": world["tru"],         # a venture in her org she can't access
        "lead_id": world["b_lead"],
        "alice_email": alice.email,
        "tru": world["tru"],
        "workflow": "lead_triage", "agent": "proposal", "action": "gmail.send", "loan_type": "home_loan",
        "entity": "dishes", "report": "sales",
    }
    forbidden_markers = {world["b_lead"], "Sharma family", "PAN pending", world["tru"]}
    checked = 0
    for path, ops in app.openapi()["paths"].items():
        if path.startswith(PUBLIC_PREFIXES) or not PARAM.search(path):
            continue
        for method in ops:
            if (path, method) in SELF_SERVICE:
                continue
            params = {name: subs.get(name, str(uuid.uuid4())) for name in PARAM.findall(path)}
            url = path.format(**params)
            kwargs = {}
            if method in ("post", "patch", "put"):
                kwargs["json"] = _fill(SAMPLE_BODIES.get(path, {}), subs)
            resp = await getattr(alice, method)(url, **kwargs)
            body = resp.text
            assert not any(m in body for m in forbidden_markers), f"{method.upper()} {url} leaked data: {body[:300]}"
            if method == "get" and resp.status_code == 200:
                assert _empty(resp.json()), f"GET {url} -> {body[:300]}"
            else:
                assert resp.status_code in (404, 422), f"{method.upper()} {url} -> {resp.status_code} {body[:200]}"
            checked += 1
    assert checked >= 10, "route sweep found fewer routes than expected"


# ---------------------------------------------------------------------------
# Database-level guarantees (defence in depth beneath the API)
# ---------------------------------------------------------------------------
async def _app_conn():
    return await asyncpg.connect(f"postgresql://kritvia_app:app@localhost/{TEST_DB}")


async def test_db_enforces_isolation_without_the_api(world):
    conn = await _app_conn()
    try:
        async with conn.transaction():
            await conn.execute("SELECT set_config('app.user_id', $1, true)", str(world["alice"].id))
            ids = {str(r["venture_id"]) for r in await conn.fetch("SELECT venture_id FROM leads")}
            assert ids == {world["site"]}
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await conn.execute(
                    "INSERT INTO leads (org_id, venture_id, name) VALUES ($1, $2, 'raw sql')",
                    uuid.UUID(world["org"]), uuid.UUID(world["tru"]))
        # No context at all -> nothing visible
        async with conn.transaction():
            assert await conn.fetchval("SELECT count(*) FROM leads") == 0
            assert await conn.fetchval("SELECT count(*) FROM audit_log") == 0
    finally:
        await conn.close()


async def test_app_role_cannot_bypass_rls():
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        row = await conn.fetchrow(
            "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'kritvia_app'")
        assert not row["rolbypassrls"] and not row["rolsuper"]
        owned = await conn.fetchval(
            "SELECT count(*) FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner"
            " WHERE r.rolname = 'kritvia_app'")
        assert owned == 0
    finally:
        await conn.close()


async def test_every_public_table_has_forced_rls():
    """Guards future migrations: a new table without RLS fails CI."""
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        rows = await conn.fetch(
            "SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c"
            " JOIN pg_namespace n ON n.oid = c.relnamespace"
            " WHERE n.nspname = 'public' AND c.relkind = 'r'"
            " AND c.relname NOT IN ('schema_migrations', 'roles')")
        unprotected = [r["relname"] for r in rows if not (r["relrowsecurity"] and r["relforcerowsecurity"])]
        assert unprotected == []

        # Every table with a venture_id column must be registered as a tenant table
        with_venture = {r["table_name"] for r in await conn.fetch(
            "SELECT table_name FROM information_schema.columns"
            " WHERE table_schema = 'public' AND column_name = 'venture_id'")}
        registered = {r["table_name"] for r in await conn.fetch("SELECT table_name FROM private.tenant_tables")}
        assert with_venture - {"memberships", "grants", "audit_log", "invitations"} <= registered
    finally:
        await conn.close()
