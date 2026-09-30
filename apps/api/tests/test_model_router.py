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
    assert res.deployment == "openrouter-free" and res.attempts == 2
    assert fake.calls == ["groq-llama-8b", "openrouter-free"]
    rows = await metered(wf)
    assert [(r["provider_model"], r["status"]) for r in rows] == [
        ("groq-llama-8b", "rate_limited"), ("openrouter-free", "ok")]
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


async def test_all_providers_down(world):
    fake = FakeLiteLLM({m: 503 for m in CONFIG.tiers["fast"]})
    with pytest.raises(AllProvidersFailed) as exc:
        await make_router(fake).chat(ctx(world, "down"), tier="fast", messages=[])
    assert len(exc.value.attempts) == len(CONFIG.tiers["fast"])


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
