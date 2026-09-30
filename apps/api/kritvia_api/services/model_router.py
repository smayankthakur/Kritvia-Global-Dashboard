"""Capability-tier model router.

Workflows call   router.chat(tier="reason", messages=..., sensitive=False)
and never name a model. The router:

  1. resolves the tier to an ordered list of LiteLLM deployments (tiers.yaml)
  2. drops any deployment whose data policy is not allowed for sensitive data
     (and refuses outright if nothing is left — the call is recorded as 'blocked')
  3. tries each deployment in order, falling back on rate limits, 5xx and
     timeouts, but NOT on 4xx request errors (those would fail everywhere)
  4. writes one model_calls row per attempt (metadata only, never content),
     which also lands in the audit log through the table trigger. Metering
     uses its own short transaction, so a failed or blocked call is still
     recorded even if the caller's transaction later rolls back.

Swapping a model is a config edit; no deploy of workflow code.
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import yaml
from sqlalchemy import text

from kritvia_api.db.session import ActorType, tenant_tx

RETRYABLE_STATUS = {408, 409, 429, 500, 502, 503, 504}


class RouterError(Exception):
    pass


class PolicyViolation(RouterError):
    """Sensitive data would have been sent somewhere it is not allowed to go."""


class AllProvidersFailed(RouterError):
    def __init__(self, tier: str, attempts: list[str]) -> None:
        super().__init__(f"all deployments failed for tier '{tier}': {'; '.join(attempts)}")
        self.attempts = attempts


@dataclass(frozen=True)
class TierConfig:
    tiers: dict[str, list[str]]
    policies: dict[str, str]
    sensitive_allowed: frozenset[str]

    @classmethod
    def load(cls, path: Path) -> TierConfig:
        raw = yaml.safe_load(path.read_text())
        policies = {name: d["data_policy"] for name, d in raw["deployments"].items()}
        tiers = {t: list(chain) for t, chain in raw["tiers"].items()}
        for tier, chain in tiers.items():
            unknown = [d for d in chain if d not in policies]
            if unknown:
                raise RouterError(f"tier '{tier}' references undeclared deployments: {unknown}")
        return cls(tiers=tiers, policies=policies, sensitive_allowed=frozenset(raw["sensitive_allowed"]))

    def candidates(self, tier: str, sensitive: bool) -> list[str]:
        if tier not in self.tiers:
            raise RouterError(f"unknown tier '{tier}'")
        chain = self.tiers[tier]
        if not sensitive:
            return chain
        return [d for d in chain if self.policies[d] in self.sensitive_allowed]


@dataclass
class CallContext:
    org_id: uuid.UUID
    venture_id: uuid.UUID
    user_id: uuid.UUID | None
    actor_type: ActorType = "user"
    agent_id: str | None = None
    workflow: str | None = None


@dataclass
class ChatResult:
    content: str
    deployment: str
    attempts: int
    usage: dict[str, Any] = field(default_factory=dict)


class ModelRouter:
    def __init__(
        self,
        config: TierConfig,
        base_url: str,
        api_key: str,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout_s: float = 120.0,
    ) -> None:
        self.config = config
        self._client = httpx.AsyncClient(
            base_url=base_url,
            headers={"Authorization": f"Bearer {api_key}"},
            transport=transport,
            timeout=timeout_s,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _meter(self, ctx: CallContext, **row: Any) -> None:
        async with tenant_tx(ctx.user_id, ctx.actor_type, ctx.agent_id) as conn:
            await conn.execute(
                text(
                    "INSERT INTO model_calls (org_id, venture_id, workflow, tier, provider_model, attempt, status,"
                    " prompt_tokens, completion_tokens, latency_ms, error)"
                    " VALUES (:org, :venture, :workflow, :tier, :model, :attempt, :status,"
                    " :pt, :ct, :latency, :error)"
                ),
                {
                    "org": ctx.org_id, "venture": ctx.venture_id, "workflow": ctx.workflow,
                    "tier": row["tier"], "model": row.get("model"), "attempt": row.get("attempt", 1),
                    "status": row["status"], "pt": row.get("pt"), "ct": row.get("ct"),
                    "latency": row.get("latency"), "error": (row.get("error") or None) and row["error"][:500],
                },
            )

    async def chat(
        self,
        ctx: CallContext,
        *,
        tier: str,
        messages: list[dict[str, Any]],
        sensitive: bool = False,
        **params: Any,
    ) -> ChatResult:
        candidates = self.config.candidates(tier, sensitive)
        if not candidates:
            reason = "sensitive request: no deployment in tier is permitted for sensitive data"
            await self._meter(ctx, tier=tier, status="blocked", error=reason)
            raise PolicyViolation(f"tier '{tier}': {reason}; route sensitive work through tier 'private'")

        failures: list[str] = []
        for attempt, deployment in enumerate(candidates, start=1):
            started = time.perf_counter()
            try:
                resp = await self._client.post(
                    "/v1/chat/completions", json={"model": deployment, "messages": messages, **params}
                )
            except httpx.TransportError as exc:  # timeouts, connection refused
                latency = int((time.perf_counter() - started) * 1000)
                await self._meter(ctx, tier=tier, model=deployment, attempt=attempt,
                                  status="error", latency=latency, error=type(exc).__name__)
                failures.append(f"{deployment}: {type(exc).__name__}")
                continue

            latency = int((time.perf_counter() - started) * 1000)
            if resp.status_code == 200:
                body = resp.json()
                usage = body.get("usage") or {}
                await self._meter(ctx, tier=tier, model=deployment, attempt=attempt, status="ok",
                                  latency=latency, pt=usage.get("prompt_tokens"),
                                  ct=usage.get("completion_tokens"))
                return ChatResult(
                    content=body["choices"][0]["message"]["content"],
                    deployment=deployment, attempts=attempt, usage=usage,
                )

            status = "rate_limited" if resp.status_code == 429 else "error"
            await self._meter(ctx, tier=tier, model=deployment, attempt=attempt, status=status,
                              latency=latency, error=f"HTTP {resp.status_code}: {resp.text[:200]}")
            failures.append(f"{deployment}: HTTP {resp.status_code}")
            if resp.status_code not in RETRYABLE_STATUS:
                break  # a malformed request will fail on every provider

        raise AllProvidersFailed(tier, failures)


async def _post_with_fallback(  # shared fallback loop for embeddings and speech
    router: ModelRouter, ctx: CallContext, tier: str, sensitive: bool,
                              send, parse):
    candidates = router.config.candidates(tier, sensitive)
    if not candidates:
        reason = "sensitive request: no deployment in tier is permitted for sensitive data"
        await router._meter(ctx, tier=tier, status="blocked", error=reason)
        raise PolicyViolation(f"tier '{tier}': {reason}")
    failures: list[str] = []
    for attempt, deployment in enumerate(candidates, start=1):
        started = time.perf_counter()
        try:
            resp = await send(deployment)
        except httpx.TransportError as exc:
            await router._meter(ctx, tier=tier, model=deployment, attempt=attempt, status="error",
                                latency=int((time.perf_counter() - started) * 1000),
                                error=type(exc).__name__)
            failures.append(f"{deployment}: {type(exc).__name__}")
            continue
        latency = int((time.perf_counter() - started) * 1000)
        if resp.status_code == 200:
            body = resp.json()
            usage = body.get("usage") or {}
            await router._meter(ctx, tier=tier, model=deployment, attempt=attempt, status="ok",
                                latency=latency, pt=usage.get("prompt_tokens"),
                                ct=usage.get("completion_tokens"))
            return parse(body), deployment
        status = "rate_limited" if resp.status_code == 429 else "error"
        await router._meter(ctx, tier=tier, model=deployment, attempt=attempt, status=status,
                            latency=latency, error=f"HTTP {resp.status_code}: {resp.text[:200]}")
        failures.append(f"{deployment}: HTTP {resp.status_code}")
        if resp.status_code not in RETRYABLE_STATUS:
            break
    raise AllProvidersFailed(tier, failures)


async def embed(router: ModelRouter, ctx: CallContext, texts: list[str], *, sensitive: bool = False,
                tier: str = "embed") -> list[list[float]]:
    """Embeddings through the tier chain. Returns one vector per input, in order."""
    if not texts:
        return []

    async def send(deployment: str):
        return await router._client.post("/v1/embeddings", json={"model": deployment, "input": texts})

    def parse(body: dict) -> list[list[float]]:
        data = sorted(body["data"], key=lambda d: d.get("index", 0))
        return [d["embedding"] for d in data]

    vectors, _ = await _post_with_fallback(router, ctx, tier, sensitive, send, parse)
    if len(vectors) != len(texts):
        raise RouterError("embedding count mismatch")
    return vectors


@dataclass
class Transcript:
    text: str
    language: str | None
    segments: list[dict[str, Any]]
    deployment: str


async def transcribe(router: ModelRouter, ctx: CallContext, audio: bytes, filename: str, *,
                     sensitive: bool = False, language: str | None = None,
                     tier: str = "speech") -> Transcript:
    """Speech-to-text. Segments carry start/end seconds so extracted facts can cite timestamps."""

    async def send(deployment: str):
        data = {"model": deployment, "response_format": "verbose_json"}
        if language:
            data["language"] = language
        return await router._client.post("/v1/audio/transcriptions", data=data,
                                         files={"file": (filename, audio)})

    def parse(body: dict) -> dict:
        return body

    body, deployment = await _post_with_fallback(router, ctx, tier, sensitive, send, parse)
    segments = [
        {"start": float(s.get("start", 0)), "end": float(s.get("end", 0)), "text": s.get("text", "").strip(),
         "speaker": s.get("speaker")}
        for s in body.get("segments") or []
    ]
    return Transcript(text=body.get("text", "").strip(), language=body.get("language"),
                      segments=segments, deployment=deployment)
