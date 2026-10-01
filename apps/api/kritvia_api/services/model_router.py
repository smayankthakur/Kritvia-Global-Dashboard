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
from collections.abc import Callable
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
    # Optional per-deployment metadata. `provider: sarvam` deployments are called natively
    # (not through LiteLLM); `engine` groups speech deployments for the user's engine choice.
    meta: dict[str, dict[str, Any]] = field(default_factory=dict)

    @classmethod
    def load(cls, path: Path) -> TierConfig:
        raw = yaml.safe_load(path.read_text())
        policies = {name: d["data_policy"] for name, d in raw["deployments"].items()}
        meta = {name: {k: v for k, v in d.items() if k != "data_policy"} for name, d in raw["deployments"].items()}
        tiers = {t: list(chain) for t, chain in raw["tiers"].items()}
        for tier, chain in tiers.items():
            unknown = [d for d in chain if d not in policies]
            if unknown:
                raise RouterError(f"tier '{tier}' references undeclared deployments: {unknown}")
        return cls(tiers=tiers, policies=policies, sensitive_allowed=frozenset(raw["sensitive_allowed"]),
                   meta=meta)

    def provider(self, deployment: str) -> str:
        return str(self.meta.get(deployment, {}).get("provider", "litellm"))

    def engine(self, deployment: str) -> str:
        """Speech engine family: 'sarvam', 'local' (never leaves our infrastructure) or 'whisper'."""
        explicit = self.meta.get(deployment, {}).get("engine")
        if explicit:
            return str(explicit)
        if self.provider(deployment) == "sarvam":
            return "sarvam"
        return "local" if self.policies.get(deployment) == "local" else "whisper"

    def is_private(self, deployment: str) -> bool:
        return self.policies.get(deployment) in self.sensitive_allowed

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
        sarvam_api_key: str = "",
        sarvam_base_url: str = "https://api.sarvam.ai",
    ) -> None:
        self.config = config
        self._client = httpx.AsyncClient(
            base_url=base_url,
            headers={"Authorization": f"Bearer {api_key}"},
            transport=transport,
            timeout=timeout_s,
        )
        # Native providers that LiteLLM does not front. The key never goes to LiteLLM.
        self.sarvam_api_key = sarvam_api_key
        self._sarvam = httpx.AsyncClient(base_url=sarvam_base_url, transport=transport, timeout=60.0)

    async def aclose(self) -> None:
        await self._client.aclose()
        await self._sarvam.aclose()

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


class _Skip(Exception):
    """A deployment that cannot serve this request (not configured, wrong language); try the next."""


# Provider-specific limits (audio length, language) surface as 4xx from native providers;
# the next deployment can still succeed, unlike a malformed request through LiteLLM.
NATIVE_FALLBACK_STATUS = {400, 401, 403, 413, 415, 422}


async def _post_with_fallback(  # shared fallback loop for embeddings and speech
    router: ModelRouter, ctx: CallContext, tier: str, sensitive: bool,
                              send, parse, candidates: list[str] | None = None):
    if candidates is None:
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
        except _Skip as exc:
            failures.append(f"{deployment}: {exc}")
            continue
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
            return parse(body, deployment), deployment
        status = "rate_limited" if resp.status_code == 429 else "error"
        await router._meter(ctx, tier=tier, model=deployment, attempt=attempt, status=status,
                            latency=latency, error=f"HTTP {resp.status_code}: {resp.text[:200]}")
        failures.append(f"{deployment}: HTTP {resp.status_code}")
        native = router.config.provider(deployment) != "litellm"
        if resp.status_code not in RETRYABLE_STATUS and not (native and resp.status_code in NATIVE_FALLBACK_STATUS):
            break
    raise AllProvidersFailed(tier, failures)


async def embed(router: ModelRouter, ctx: CallContext, texts: list[str], *, sensitive: bool = False,
                tier: str = "embed") -> list[list[float]]:
    """Embeddings through the tier chain. Returns one vector per input, in order."""
    if not texts:
        return []

    async def send(deployment: str):
        return await router._client.post("/v1/embeddings", json={"model": deployment, "input": texts})

    def parse(body: dict, _deployment: str) -> list[list[float]]:
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
    engine: str = "whisper"


# Languages Sarvam's speech models accept (BCP-47 with -IN), keyed by ISO 639 code.
SARVAM_LANGUAGES = {"en": "en-IN", "hi": "hi-IN", "bn": "bn-IN", "ta": "ta-IN", "te": "te-IN", "mr": "mr-IN",
                    "gu": "gu-IN", "kn": "kn-IN", "ml": "ml-IN", "pa": "pa-IN", "or": "od-IN", "od": "od-IN",
                    "as": "as-IN", "ur": "ur-IN", "ne": "ne-IN", "sa": "sa-IN", "sd": "sd-IN", "ks": "ks-IN",
                    "doi": "doi-IN", "mni": "mni-IN", "brx": "brx-IN", "mai": "mai-IN", "sat": "sat-IN",
                    "kok": "kok-IN"}

ENGINES = ("auto", "sarvam", "whisper", "local")


def speech_candidates(config: TierConfig, tier: str, *, sensitive: bool, engine: str = "auto",
                      language: str | None = None) -> list[str]:
    """Order the tier's deployments for the user's engine choice.

    * 'local'   only deployments whose data never leaves our infrastructure (no fallback to cloud)
    * 'sarvam' / 'whisper'  that family first, the rest of the chain as fallback (the response
      names the deployment that answered, so the UI can say so)
    * 'auto'    the configured order, minus Sarvam when the language is one it does not support
    The sensitive-data policy is applied first and always wins.
    """
    chain = config.candidates(tier, sensitive)
    if language and language not in ("auto", "") and language not in SARVAM_LANGUAGES:
        chain = [d for d in chain if config.engine(d) != "sarvam"]
    if engine == "local":
        return [d for d in chain if config.policies.get(d) == "local"]
    if engine in ("sarvam", "whisper"):
        first = [d for d in chain if config.engine(d) == engine]
        return first + [d for d in chain if d not in first]
    return chain


HintsFor = Callable[[str], list[str]]


async def transcribe(router: ModelRouter, ctx: CallContext, audio: bytes, filename: str, *,
                     sensitive: bool = False, language: str | None = None,
                     tier: str = "speech", engine: str = "auto",
                     hints_for: HintsFor | None = None) -> Transcript:
    """Speech-to-text. Segments carry start/end seconds so extracted facts can cite timestamps.

    `hints_for(deployment)` returns spelling hints (vocabulary, names) allowed for that
    deployment's data policy: Whisper gets them as a glossary prompt, Sarvam as keyterms.
    """
    lang = None if language in (None, "", "auto") else language
    candidates = speech_candidates(router.config, tier, sensitive=sensitive, engine=engine, language=lang)
    if not candidates and engine == "local":
        await router._meter(ctx, tier=tier, status="blocked", error="no local speech deployment")
        raise PolicyViolation(f"tier '{tier}': no local speech deployment is configured")

    async def send(deployment: str):
        hints = hints_for(deployment) if hints_for else []
        if router.config.provider(deployment) == "sarvam":
            return await _sarvam_send(router, deployment, audio, filename, lang, hints)
        data: dict[str, Any] = {"model": deployment, "response_format": "verbose_json"}
        if lang:
            data["language"] = lang
        if hints:
            from kritvia_api.services.speech import whisper_prompt
            data["prompt"] = whisper_prompt(hints)
        return await router._client.post("/v1/audio/transcriptions", data=data,
                                         files={"file": (filename, audio)})

    def parse(body: dict, deployment: str) -> dict:
        if router.config.provider(deployment) == "sarvam":
            return {"text": body.get("transcript") or "", "language": _iso(body.get("language_code")),
                    "segments": []}
        return body

    body, deployment = await _post_with_fallback(router, ctx, tier, sensitive, send, parse, candidates)
    segments = [
        {"start": float(s.get("start", 0)), "end": float(s.get("end", 0)), "text": s.get("text", "").strip(),
         "speaker": s.get("speaker")}
        for s in body.get("segments") or []
    ]
    return Transcript(text=(body.get("text") or "").strip(), language=body.get("language"),
                      segments=segments, deployment=deployment, engine=router.config.engine(deployment))


def _iso(code: str | None) -> str | None:
    if not code:
        return None
    return code.split("-")[0].lower()


async def _sarvam_send(router: ModelRouter, deployment: str, audio: bytes, filename: str,
                       language: str | None, hints: list[str]) -> httpx.Response:
    if not router.sarvam_api_key:
        raise _Skip("SARVAM_API_KEY is not set")
    meta = router.config.meta.get(deployment, {})
    model = str(meta.get("model", "saaras:v4"))
    data: dict[str, Any] = {"model": model, "language_code": SARVAM_LANGUAGES.get(language or "", "unknown")}
    if model.endswith(":v3"):
        data["mode"] = str(meta.get("mode", "transcribe"))  # 'mode' applies to saaras:v3 only
    headers = {"api-subscription-key": router.sarvam_api_key}
    if hints and not model.endswith(":v3"):
        # keyterms bias recognition towards domain terms (saaras:v4: up to 50, 64 chars each)
        import json
        resp = await router._sarvam.post(
            "/speech-to-text", data={**data, "keyterms": json.dumps([h[:64] for h in hints[:50]])},
            files={"file": (filename, audio)}, headers=headers)
        if resp.status_code not in (400, 422):
            return resp
        # an unaccepted keyterms format must not cost the transcription: retry once without
    return await router._sarvam.post("/speech-to-text", data=data, files={"file": (filename, audio)},
                                     headers=headers)
