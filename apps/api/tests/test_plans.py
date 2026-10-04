"""Plan limits: businesses, people, autonomy and the monthly hosted-AI allowance."""
from __future__ import annotations

import uuid

import asyncpg

from conftest import ADMIN_DSN, make_actor
from kritvia_api.config import get_settings


async def _free_org(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "default_plan", "free")
    owner = await make_actor(client, "freeowner")
    slug = "free-" + uuid.uuid4().hex[:8]
    org = (await owner.post("/orgs", json={"name": "Free Co", "slug": slug})).json()["id"]
    return owner, org


async def test_free_plan_limits_ventures_members_and_autonomy(client, monkeypatch):
    owner, org = await _free_org(client, monkeypatch)
    plan = (await owner.get(f"/orgs/{org}/plan")).json()
    assert plan["plan"]["code"] == "free" and plan["tokens"] == 0 and plan["tokens_left"] == 300_000
    assert [p["code"] for p in plan["available"]] == ["free", "starter", "growth", "scale", "enterprise"]
    assert [p["tokens"] for p in plan["token_packs"]] == [5_000_000, 20_000_000, 50_000_000]

    v = await owner.post(f"/orgs/{org}/ventures", json={"name": "One", "slug": "one"})
    assert v.status_code == 201
    vid = v.json()["id"]
    r = await owner.post(f"/orgs/{org}/ventures", json={"name": "Two", "slug": "two"})
    assert r.status_code == 402 and "Free plan includes 1 business;" in r.text

    friend = await make_actor(client, "friend")
    inv = await owner.post(f"/orgs/{org}/invitations", json={"email": friend.email, "role": "operator", "venture_id": vid})
    assert inv.status_code == 201, inv.text
    assert (await friend.post("/invitations/accept", json={"token": inv.json()["token"]})).status_code == 200
    third = await owner.post(f"/orgs/{org}/invitations", json={"email": "x@example.com", "role": "operator", "venture_id": vid})
    assert third.status_code == 402

    r = await owner.post(f"/ventures/{vid}/trust/proposal_writer/gmail.send", json={"auto_run": True, "reason": "trusted"})
    assert r.status_code == 402

    # an upgrade (as the billing webhook does) lifts the limits
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute("SELECT set_org_plan($1, 'growth', now() + interval '30 days')", uuid.UUID(org))
    finally:
        await conn.close()
    assert (await owner.post(f"/orgs/{org}/ventures", json={"name": "Two", "slug": "two"})).status_code == 201
    assert (await owner.get(f"/orgs/{org}/plan")).json()["plan"]["code"] == "growth"


async def test_ai_allowance_falls_back_to_local_then_refuses(client, monkeypatch, services, fake_llm):
    owner, org = await _free_org(client, monkeypatch)
    vid = (await owner.post(f"/orgs/{org}/ventures", json={"name": "One", "slug": "one"})).json()["id"]
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute("INSERT INTO model_calls (org_id, venture_id, tier, provider_model, status, prompt_tokens,"
                           " completion_tokens) VALUES ($1, $2, 'reason', 'groq-llama-70b', 'ok', 250000, 60000)",
                           uuid.UUID(org), uuid.UUID(vid))
    finally:
        await conn.close()
    services.router.gate.forget(uuid.UUID(org))
    assert (await owner.get(f"/orgs/{org}/plan")).json()["tokens_left"] == 0

    from kritvia_api.services.model_router import CallContext, QuotaExceeded
    ctx = CallContext(org_id=uuid.UUID(org), venture_id=uuid.UUID(vid), user_id=owner.id)
    fake_llm.on("hello there", "hi")
    res = await services.router.chat(ctx, tier="reason", messages=[{"role": "user", "content": "hello there"}])
    assert res.deployment == "ollama-qwen-7b"          # hosted models skipped, the local model answered

    # a tier with no local model is refused with a clear message
    try:
        await services.router.chat(ctx, tier="long_context", messages=[{"role": "user", "content": "hi"}])
        raise AssertionError("expected QuotaExceeded")
    except QuotaExceeded as exc:
        assert "monthly AI allowance" in str(exc)
