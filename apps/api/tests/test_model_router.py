"""Exit criterion: a model call routes by tier and falls back on rate limit.
Plus: sensitive data can never reach a provider that may train on it."""
from __future__ import annotations

import json
import uuid
from pathlib import Path

import asyncpg
import httpx
import pytest
import yaml

from conftest import ADMIN_DSN

from kritvia_api.config import get_settings
from kritvia_api.services.model_router import (
    AllProvidersFailed, CallContext, ModelRouter, PolicyViolation, RouterError, TierConfig,
)

pytestmark = pytest.mark.asyncio
CONFIG = TierConfig.load(get_settings().tiers_config_path)


class FakeLiteLLM:
    """Scripted LiteLLM proxy: maps deployment name -> HTTP status."""

    def __init__(self, script: dict[str, int]):
        self.script, self.calls = script, []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        model = json.loads(request.content)["model"]
        self.calls.append(model)
        code = self.script.get(model, 200)
        if code == 200:
            return httpx.Response(200, json={
                "choices": [{"message": {"content": f"hello from {model}"}}],
                "usage": {"prompt_tokens": 11, "completion_tokens": 7}})
        return httpx.Response(code, json={"error": "scripted"})


def make_router(fake: FakeLiteLLM) -> ModelRouter:
    return ModelRouter(CONFIG, "http://litellm", "k", transport=httpx.MockTransport(fake))


def ctx(world, workflow: str) -> CallContext:
    return CallContext(org_id=uuid.UUID(world["org"]), venture_id=uuid.UUID(world["site"]),
                       user_id=world["alice"].id, workflow=workflow)


async def metered(workflow: str):
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        return await conn.fetch("SELECT * FROM model_calls WHERE workflow = $1 ORDER BY attempt", workflow)
    finally:
        await conn.close()


async def test_falls_back_on_rate_limit_and_meters_each_attempt(world):
    fake = FakeLiteLLM({"groq-llama-8b": 429})
    wf = f"fallback-{uuid.uuid4().hex[:6]}"
    res = await make_router(fake).chat(ctx(world, wf), tier="fast", messages=[{"role": "user", "content": "hi"}])
    assert res.deployment == "ollama-qwen-7b" and res.attempts == 2
    assert fake.calls == ["groq-llama-8b", "ollama-qwen-7b"]
    rows = await metered(wf)
    assert [(r["provider_model"], r["status"]) for r in rows] == [
        ("groq-llama-8b", "rate_limited"), ("ollama-qwen-7b", "ok")]
    assert rows[1]["prompt_tokens"] == 11


async def test_sensitive_request_only_reaches_local_models(world):
    fake = FakeLiteLLM({})
    res = await make_router(fake).chat(ctx(world, "sens"), tier="reason", sensitive=True,
                                       messages=[{"role": "user", "content": "PAN ABCDE1234F"}])
    assert fake.calls == ["ollama-qwen-7b"] and res.deployment == "ollama-qwen-7b"


async def test_sensitive_request_blocked_when_tier_has_no_safe_provider(world):
    fake = FakeLiteLLM({})
    wf = f"blocked-{uuid.uuid4().hex[:6]}"
    with pytest.raises(PolicyViolation):
        await make_router(fake).chat(ctx(world, wf), tier="long_context", sensitive=True,
                                     messages=[{"role": "user", "content": "loan file"}])
    assert fake.calls == []                      # nothing left the building
    rows = await metered(wf)
    assert len(rows) == 1 and rows[0]["status"] == "blocked"   # and the attempt is on record


async def test_request_errors_do_not_cascade(world):
    fake = FakeLiteLLM({"groq-llama-8b": 400})
    with pytest.raises(AllProvidersFailed):
        await make_router(fake).chat(ctx(world, "bad"), tier="fast", messages=[])
    assert fake.calls == ["groq-llama-8b"]


async def test_bad_provider_key_falls_through_to_next_deployment(world):
    """A wrong or expired API key (401) is one provider's problem, not the request's."""
    fake = FakeLiteLLM({"groq-llama-8b": 401})
    res = await make_router(fake).chat(ctx(world, "badkey"), tier="fast", messages=[{"role": "user", "content": "hi"}])
    assert res.deployment == "ollama-qwen-7b" and fake.calls == ["groq-llama-8b", "ollama-qwen-7b"]


async def test_all_providers_down(world):
    fake = FakeLiteLLM({m: 503 for m in CONFIG.tiers["fast"]})
    with pytest.raises(AllProvidersFailed) as exc:
        await make_router(fake).chat(ctx(world, "down"), tier="fast", messages=[])
    # every deployment this server can use without opt-in was tried: no-training ones with a key, and local
    assert exc.value.attempts == [f"{d}: HTTP 503" for d in ("groq-llama-8b", "ollama-qwen-7b")]


async def test_private_tier_is_local_only_in_shipped_config():
    for d in CONFIG.tiers["private"]:
        assert CONFIG.policies[d] in CONFIG.sensitive_allowed


async def test_config_rejects_undeclared_deployments(tmp_path: Path):
    bad = {"sensitive_allowed": ["local"], "deployments": {"a": {"data_policy": "local"}},
           "tiers": {"fast": ["a", "ghost"]}}
    p = tmp_path / "tiers.yaml"
    p.write_text(yaml.safe_dump(bad))
    with pytest.raises(RouterError, match="ghost"):
        TierConfig.load(p)


async def test_model_calls_are_audited(world):
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        n = await conn.fetchval("SELECT count(*) FROM audit_log WHERE action = 'model_calls.insert'")
    finally:
        await conn.close()
    assert n > 0


async def test_training_models_are_never_first_and_never_private():
    """Models that may train are opt-in per organisation (see test_ai_models.py); they never sit in the
    private, embedding or speech tiers, never come before a no-training model, and sensitive data
    only ever reaches our own server."""
    assert CONFIG.sensitive_allowed == frozenset({"local"})
    for tier in ("private", "embed", "speech", "dictation"):
        assert all(CONFIG.policies[d] != "may_train" for d in CONFIG.tiers[tier]), tier
    for tier in ("fast", "extract", "reason"):
        assert CONFIG.policies[CONFIG.tiers[tier][0]] == "no_training", tier


# ------------------------------------------------------------------ fair share of the free pool --
async def _busy_org(client, tokens: int):
    from conftest import make_actor
    owner = await make_actor(client, "busy")
    org = (await owner.post("/orgs", json={"name": "Busy Co", "slug": "busy-" + uuid.uuid4().hex[:8]})).json()["id"]
    v = (await owner.post(f"/orgs/{org}/ventures", json={"name": "One", "slug": "one"})).json()["id"]
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute("INSERT INTO model_calls (org_id, venture_id, tier, provider_model, status, prompt_tokens,"
                           " completion_tokens) VALUES ($1, $2, 'reason', 'groq-llama-70b', 'ok', $3, 0)",
                           uuid.UUID(org), uuid.UUID(v), tokens)
    finally:
        await conn.close()
    return CallContext(org_id=uuid.UUID(org), venture_id=uuid.UUID(v), user_id=owner.id, actor_type="user",
                       workflow=f"share-{uuid.uuid4().hex[:6]}")


async def test_past_its_fair_share_a_business_moves_off_the_free_pool(client, monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "ai_free_pool_daily_tokens", 1_000_000)
    monkeypatch.setattr(s, "ai_free_share_floor", 60_000)
    monkeypatch.setattr(s, "ai_user_daily_tokens", 0)
    c = await _busy_org(client, 1_100_000)   # over the whole pool, whatever else ran today
    fake = FakeLiteLLM({})
    res = await make_router(fake).chat(c, tier="fast", messages=[{"role": "user", "content": "hi"}])
    # the shared free models are skipped; our own server still answers
    assert fake.calls == ["ollama-qwen-7b"] and res.deployment == "ollama-qwen-7b"

    # a tier with nothing but free hosted models explains how to keep going
    from kritvia_api.services.model_router import QuotaExceeded
    with pytest.raises(QuotaExceeded, match="fair share"):
        await make_router(FakeLiteLLM({})).chat(c, tier="long_context", messages=[{"role": "user", "content": "hi"}])


async def test_a_quiet_business_keeps_the_free_pool(client, monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "ai_free_pool_daily_tokens", 1_000_000)
    monkeypatch.setattr(s, "ai_user_daily_tokens", 0)
    c = await _busy_org(client, 1_000)
    fake = FakeLiteLLM({})
    res = await make_router(fake).chat(c, tier="fast", messages=[{"role": "user", "content": "hi"}])
    assert res.deployment == "groq-llama-8b"


async def test_fair_share_can_be_switched_off(client, monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "ai_free_pool_daily_tokens", 0)
    monkeypatch.setattr(s, "ai_user_daily_tokens", 0)
    c = await _busy_org(client, 5_000_000)
    res = await make_router(FakeLiteLLM({})).chat(c, tier="fast", messages=[{"role": "user", "content": "hi"}])
    assert res.deployment == "groq-llama-8b"


async def test_free_pool_is_hosted_free_tiers_only():
    pool = set(CONFIG.free_pool())
    assert {"groq-llama-70b", "groq-llama-8b", "cerebras-large"} <= pool
    assert not any(CONFIG.policies[d] == "local" for d in pool)


async def test_paid_models_only_when_switched_on_and_never_in_the_free_pool(client, monkeypatch):
    assert "openrouter-paid" not in CONFIG.free_pool() and "openrouter-planner" not in CONFIG.free_pool()
    assert CONFIG.tiers["plan"][0] == "openrouter-planner"
    s = get_settings()
    monkeypatch.setattr(s, "ai_free_pool_daily_tokens", 1_000_000)
    monkeypatch.setattr(s, "ai_user_daily_tokens", 0)
    c = await _busy_org(client, 1_100_000)          # past its fair share of the free pool
    monkeypatch.delenv("OPENROUTER_PAID_ENABLED", raising=False)
    fake = FakeLiteLLM({})
    assert (await make_router(fake).chat(c, tier="reason", messages=[{"role": "user", "content": "hi"}])).deployment \
        == "ollama-qwen-7b"
    monkeypatch.setenv("OPENROUTER_PAID_ENABLED", "1")
    fake = FakeLiteLLM({})
    res = await make_router(fake).chat(c, tier="reason", messages=[{"role": "user", "content": "hi"}])
    assert res.deployment == "openrouter-paid" and fake.calls == ["openrouter-paid"]
