"""Free models first; training models only on opt-in (never with Google, never sensitive);
an organisation's own keys go first, straight to the provider, outside the plan allowance."""
from __future__ import annotations

import json
import uuid

import asyncpg
import httpx
import pytest

from conftest import ADMIN_DSN, make_actor
from kritvia_api.config import get_settings
from kritvia_api.services.model_router import CallContext, ModelRouter, TierConfig

pytestmark = pytest.mark.asyncio
CONFIG = TierConfig.load(get_settings().tiers_config_path)


class Provider:
    """Answers LiteLLM and the providers' own endpoints; records where each call went."""

    def __init__(self, reject_key: str | None = None):
        self.calls: list[tuple[str, str, str | None]] = []   # (host, model, bearer)
        self.reject_key = reject_key

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content or b"{}")
        bearer = request.headers.get("authorization", "").removeprefix("Bearer ")
        self.calls.append((request.url.host, body.get("model"), bearer))
        if self.reject_key and bearer == self.reject_key:
            return httpx.Response(401, json={"error": "bad key"})
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}],
                                         "usage": {"prompt_tokens": 7, "completion_tokens": 3}})


@pytest.fixture
def owner_org(world):
    return world["mayank"], world["org"], world["site"]


async def test_free_models_first_training_models_only_on_opt_in(owner_org, services):
    mayank, org, site = owner_org
    fake = Provider()
    router = ModelRouter(CONFIG, "http://litellm", "k", transport=httpx.MockTransport(fake))
    router.keys = services.keys
    ctx = CallContext(org_id=uuid.UUID(org), venture_id=uuid.UUID(site), user_id=mayank.id)

    # Groq down: without opt-in the next stop is our own server, never a training model
    class Down(Provider):
        def __call__(self, request):
            body = json.loads(request.content)
            self.calls.append((request.url.host, body["model"], None))
            if body["model"] == "groq-llama-8b":
                return httpx.Response(503)
            return super().__call__(request)
    down = Down()
    r2 = ModelRouter(CONFIG, "http://litellm", "k", transport=httpx.MockTransport(down))
    res = await r2.chat(ctx, tier="fast", messages=[{"role": "user", "content": "hi"}])
    assert res.deployment == "ollama-qwen-7b"
    assert not any(m in ("openrouter-free", "gemini-flash") for _, m, _ in down.calls)

    # the owner opts in: free training models join the chain after the no-training ones
    r = await mayank.put(f"/orgs/{org}/ai/settings", json={"allow_training_models": True})
    assert r.status_code == 200 and r.json()["allow_training_models"] is True
    down.calls.clear()
    r2.forget_routes()
    res = await r2.chat(ctx, tier="fast", messages=[{"role": "user", "content": "hi"}])
    assert res.deployment == "openrouter-free"
    # ... but never for sensitive work
    down.calls.clear()
    res = await r2.chat(ctx, tier="fast", messages=[{"role": "user", "content": "PAN"}], sensitive=True)
    assert res.deployment == "ollama-qwen-7b"

    # ... and never for a business with Google connected
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        cid = await conn.fetchval("INSERT INTO connectors (org_id, venture_id, provider, status)"
                                  " VALUES ($1, $2, 'google', 'active') RETURNING id", uuid.UUID(org), uuid.UUID(site))
        r2.forget_routes()
        res = await r2.chat(ctx, tier="fast", messages=[{"role": "user", "content": "hi"}])
        assert res.deployment == "ollama-qwen-7b"
    finally:
        await conn.execute("DELETE FROM connectors WHERE id = $1", cid)
        await conn.close()
    await mayank.put(f"/orgs/{org}/ai/settings", json={"allow_training_models": False})


async def test_own_key_is_verified_used_first_and_outside_the_allowance(owner_org, services, monkeypatch):
    mayank, org, site = owner_org
    fake = Provider(reject_key="sk-bad-key-0000")
    monkeypatch.setattr(services.router, "_byok", httpx.AsyncClient(transport=httpx.MockTransport(fake)))
    services.router.forget_routes()

    # a key the provider rejects is not saved
    bad = await mayank.put(f"/orgs/{org}/ai/keys/openai", json={"model": "gpt-5-mini", "api_key": "sk-bad-key-0000"})
    assert bad.status_code == 422 and "rejected" in bad.json()["detail"]
    ok = await mayank.put(f"/orgs/{org}/ai/keys/openai", json={"model": "gpt-5-mini", "api_key": "sk-good-key-1234"})
    assert ok.status_code == 200, ok.text
    k = ok.json()["keys"][0]
    assert k["provider"] == "openai" and k["hint"] == "…1234" and "sk-good" not in ok.text
    assert fake.calls[-1] == ("api.openai.com", "gpt-5-mini", "sk-good-key-1234")
    # the key is stored wrapped, and the app role cannot read even the wrapped bytes
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        wrapped = await conn.fetchval("SELECT key_wrapped FROM org_ai_keys WHERE org_id = $1", uuid.UUID(org))
    finally:
        await conn.close()
    assert b"sk-good-key-1234" not in bytes(wrapped)

    # agents now draft with the owner's key first, straight to the provider
    ctx = CallContext(org_id=uuid.UUID(org), venture_id=uuid.UUID(site), user_id=mayank.id, workflow="byok-test")
    res = await services.router.chat(ctx, tier="reason", messages=[{"role": "user", "content": "hi"}])
    assert res.deployment == "byok:openai" and fake.calls[-1][0] == "api.openai.com"
    # sensitive work never uses it
    res = await services.router.chat(ctx, tier="reason", messages=[{"role": "user", "content": "Aadhaar"}], sensitive=True)
    assert res.deployment == "ollama-qwen-7b"
    assert "byok:openai" in services.router.local_deployments()      # not counted against the plan

    # the provider later rejects it: the call falls through and the owner sees why
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        from kritvia_api.services import byok
        await conn.execute("UPDATE org_ai_keys SET key_wrapped = $1 WHERE org_id = $2",
                           byok.wrap_key(services.keys, uuid.UUID(org), "openai", "sk-bad-key-0000"), uuid.UUID(org))
    finally:
        await conn.close()
    services.router.forget_routes()
    res = await services.router.chat(ctx, tier="reason", messages=[{"role": "user", "content": "hi"}])
    assert res.deployment != "byok:openai"
    setup = (await mayank.get(f"/orgs/{org}/ai")).json()
    assert setup["keys"][0]["last_error"] == "the provider rejected this key"
    assert (await mayank.delete(f"/orgs/{org}/ai/keys/openai")).json()["keys"] == []


async def test_only_owners_change_models(world, client):
    alice, org = world["alice"], world["org"]
    setup = await alice.get(f"/orgs/{org}/ai")
    assert setup.status_code == 200 and setup.json()["can_edit"] is False
    assert (await alice.put(f"/orgs/{org}/ai/settings", json={"allow_training_models": True})).status_code == 403
    assert (await world["mallory"].get(f"/orgs/{org}/ai")).status_code == 404
    stranger = await make_actor(client, "ai-stranger")
    assert (await stranger.put(f"/orgs/{org}/ai/keys/groq", json={"model": "x", "api_key": "12345678"})).status_code == 404
