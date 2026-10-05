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

import os
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from collections.abc import Callable
from typing import Any

import httpx
import yaml
from sqlalchemy import text

from kritvia_api.config import get_settings
from kritvia_api.services import guardrails
from kritvia_api.services.security_log import security_event

from kritvia_api.db.session import ActorType, tenant_tx

RETRYABLE_STATUS = {408, 409, 429, 500, 502, 503, 504}
# A provider rejecting OUR credentials (bad or expired key, suspended account), or no longer
# serving the configured model (404), is that provider's problem; the next deployment in the
# tier must still get its turn.
PROVIDER_AUTH_STATUS = {401, 403, 404}


class RouterError(Exception):
    pass


class PolicyViolation(RouterError):
    """Sensitive data would have been sent somewhere it is not allowed to go."""


class QuotaExceeded(RouterError):
    """The workspace used its plan's hosted-model allowance for this month."""


class AgentBudgetExceeded(QuotaExceeded):
    """This agent (workflow) used the monthly token budget its owner set on the board."""


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

    def with_policies(self, deployments: list[str], policy: str) -> TierConfig:
        """Override data policies from the environment, e.g. a Gemini key with billing on is
        no_training (AI_NO_TRAINING_DEPLOYMENTS=gemini-flash)."""
        known = [d for d in deployments if d in self.policies]
        if not known:
            return self
        return TierConfig(tiers=self.tiers, policies={**self.policies, **{d: policy for d in known}},
                          sensitive_allowed=self.sensitive_allowed, meta=self.meta)

    def available(self, deployment: str) -> bool:
        """A deployment that needs a provider key this server does not have is skipped."""
        need = self.meta.get(deployment, {}).get("requires_env")
        return not need or bool(os.environ.get(str(need)))

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
    ticket_id: uuid.UUID | None = None
    run_id: uuid.UUID | None = None


@dataclass
class Route:
    """Per-venture routing facts: may free models that train be used, and the org's own keys."""
    org_id: uuid.UUID | None
    allow_training: bool
    google_connected: bool
    keys: list[tuple[str, str, bytes]]   # (provider, model, wrapped key), in the owner's order

    @property
    def training_ok(self) -> bool:
        # Google's API rules forbid Workspace data reaching models that train on it.
        return self.allow_training and not self.google_connected


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
        from kritvia_api.services.quota import TokenGate
        self.gate = TokenGate()
        # The organisation's own keys go straight to the provider (fixed base URLs), never via LiteLLM.
        self.keys = None   # KeyProvider; set by build_services
        self._byok = httpx.AsyncClient(transport=transport, timeout=timeout_s)
        self._routes: dict[uuid.UUID, tuple[float, Route]] = {}

    async def aclose(self) -> None:
        await self._client.aclose()
        await self._sarvam.aclose()
        await self._byok.aclose()

    def local_deployments(self) -> list[str]:
        """Model labels that do not count against the plan's hosted-AI allowance: our own
        servers, and calls on the organisation's own keys (the provider bills them)."""
        from kritvia_api.services.byok import all_labels
        return [d for d, p in self.config.policies.items() if p == "local"] + all_labels()

    def forget_routes(self) -> None:
        self._routes.clear()

    async def _route(self, ctx: CallContext) -> Route:
        hit = self._routes.get(ctx.venture_id)
        if hit and time.monotonic() - hit[0] < 30:
            return hit[1]
        async with tenant_tx(ctx.user_id, ctx.actor_type, ctx.agent_id) as conn:
            rows = (await conn.execute(text("SELECT * FROM private.ai_route(:v)"), {"v": ctx.venture_id})).all()
        if rows:
            r0 = rows[0]
            route = Route(org_id=r0.org_id, allow_training=bool(r0.allow_training),
                          google_connected=bool(r0.google_connected),
                          keys=[(r.provider, r.model, bytes(r.key_wrapped)) for r in rows if r.provider])
        else:
            route = Route(org_id=None, allow_training=False, google_connected=False, keys=[])
        self._routes[ctx.venture_id] = (time.monotonic(), route)
        return route

    async def _over_quota(self, ctx: CallContext) -> str | None:
        """None, 'org' (plan allowance used), 'agent' (the board budget for this workflow used) or
        'user' (this person's daily share of hosted AI used)."""
        async with tenant_tx(ctx.user_id, ctx.actor_type, ctx.agent_id) as conn:
            local = self.local_deployments()
            if ctx.workflow and await self.gate.agent_over_budget(conn, ctx.venture_id, ctx.workflow, local):
                return "agent"
            if await self.gate.over_limit(conn, ctx.org_id, local):
                return "org"
            cap = get_settings().ai_user_daily_tokens
            if cap and ctx.actor_type == "user" and ctx.user_id:
                used = (await conn.execute(text("SELECT user_tokens_today(:u, :l)"),
                                           {"u": ctx.user_id, "l": local})).scalar()
                if int(used or 0) >= cap:
                    return "user"
            return None

    async def _meter(self, ctx: CallContext, **row: Any) -> None:
        async with tenant_tx(ctx.user_id, ctx.actor_type, ctx.agent_id) as conn:
            await conn.execute(
                text(
                    "INSERT INTO model_calls (org_id, venture_id, workflow, tier, provider_model, attempt, status,"
                    " prompt_tokens, completion_tokens, latency_ms, error, agent_id, ticket_id, cost_usd, user_id)"
                    " VALUES (:org, :venture, :workflow, :tier, :model, :attempt, :status,"
                    " :pt, :ct, :latency, :error, :agent, :ticket, :cost, :user)"
                ),
                {
                    "org": ctx.org_id, "venture": ctx.venture_id, "workflow": ctx.workflow,
                    "tier": row["tier"], "model": row.get("model"), "attempt": row.get("attempt", 1),
                    "status": row["status"], "pt": row.get("pt"), "ct": row.get("ct"),
                    "latency": row.get("latency"), "error": (row.get("error") or None) and row["error"][:500],
                    "agent": ctx.agent_id, "ticket": ctx.ticket_id, "cost": row.get("cost"),
                    "user": ctx.user_id if ctx.actor_type == "user" else None,
                },
            )

    async def _guard(self, ctx: CallContext, messages: list[dict[str, Any]], params: dict[str, Any]) -> None:
        """Per-request limits: prompt size, output size, and how fast one person can call the AI."""
        s = get_settings()
        size = sum(len(m["content"]) for m in messages if isinstance(m.get("content"), str))
        if size > s.ai_max_prompt_chars:
            await self._meter(ctx, tier="-", status="blocked", error="prompt too large")
            raise PolicyViolation(f"the request is too large for the AI ({size:,} characters; the limit is "
                                  f"{s.ai_max_prompt_chars:,}); split the document or ask about a part of it")
        params["max_tokens"] = min(int(params.get("max_tokens") or s.ai_max_output_tokens), s.ai_max_output_tokens)
        if ctx.actor_type == "user" and ctx.user_id:
            from kritvia_api.ratelimit import limiter
            await limiter.hit(f"ai-user:{ctx.user_id}", per_minute=s.ai_user_calls_per_minute)

    async def chat(
        self,
        ctx: CallContext,
        *,
        tier: str,
        messages: list[dict[str, Any]],
        sensitive: bool = False,
        **params: Any,
    ) -> ChatResult:
        from kritvia_api.services import byok
        await self._guard(ctx, messages, params)
        messages, findings = guardrails.protect(messages)
        if findings:
            await security_event("ai.injection_suspected", "warning", user_id=ctx.user_id, org_id=ctx.org_id,
                                 workflow=ctx.workflow, patterns=",".join(findings))
            if ctx.run_id:
                async with tenant_tx(None, "system") as conn:
                    await conn.execute(text("SELECT flag_run(:r, :why)"),
                                       {"r": ctx.run_id, "why": "outside text tried to instruct the AI: " + ", ".join(findings)})
        candidates = self.config.candidates(tier, sensitive)
        if not candidates:
            reason = "sensitive request: no deployment in tier is permitted for sensitive data"
            await self._meter(ctx, tier=tier, status="blocked", error=reason)
            raise PolicyViolation(f"tier '{tier}': {reason}; route sensitive work through tier 'private'")
        route = await self._route(ctx)
        candidates = [d for d in candidates if self.config.available(d)
                      and (self.config.policies.get(d) != "may_train" or route.training_ok)]
        own = [] if sensitive or tier in byok.NO_BYOK_TIERS or self.keys is None else \
            [byok.label(p) for p, _, _ in route.keys if p in byok.PROVIDERS]
        candidates = own + candidates
        if not candidates:
            await self._meter(ctx, tier=tier, status="blocked", error="no model available for this tier")
            raise AllProvidersFailed(tier, ["no model is configured for this tier"])

        def hosted(d: str) -> bool:
            return self.config.policies.get(d) != "local" and not d.startswith(byok.LABEL_PREFIX)

        over = None
        if any(hosted(d) for d in candidates):
            over = await self._over_quota(ctx)
        if over == "user":
            local = [d for d in candidates if not hosted(d)]
            if not local:
                await self._meter(ctx, tier=tier, status="blocked", error="personal daily AI allowance used")
                raise QuotaExceeded("you've used today's share of hosted AI for one person; it resets at midnight IST "
                                    "(steps that can run on the local model still do)")
            candidates = local
            over = None
        if over == "agent":
            # The owner capped this agent on the board: pause it, local model or not.
            await self._meter(ctx, tier=tier, status="blocked", error="agent budget used")
            raise AgentBudgetExceeded(f"the {ctx.workflow} agent has used the monthly budget set on the "
                                      "board; raise it or wait for next month")
        if over:
            # The plan allowance covers hosted models only: the org's own keys and our servers still run.
            local = [d for d in candidates if not hosted(d)]
            if not local:
                await self._meter(ctx, tier=tier, status="blocked", error="monthly AI allowance used")
                raise QuotaExceeded("this workspace has used its monthly AI allowance; upgrade the plan or wait "
                                    "for next month (steps that can run on the local model still do)")
            candidates = local

        failures: list[str] = []
        for attempt, deployment in enumerate(candidates, start=1):
            started = time.perf_counter()
            try:
                if deployment.startswith(byok.LABEL_PREFIX):
                    resp = await self._own_key_chat(route, deployment, messages, params)
                else:
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
                                  ct=usage.get("completion_tokens"), cost=_cost_header(resp))
                return ChatResult(
                    content=body["choices"][0]["message"]["content"],
                    deployment=deployment, attempts=attempt, usage=usage,
                )

            status = "rate_limited" if resp.status_code == 429 else "error"
            own_key = deployment.startswith(byok.LABEL_PREFIX)
            # A provider's error body for a customer key is not logged: it can echo account details.
            detail = f"HTTP {resp.status_code}" if own_key else f"HTTP {resp.status_code}: {resp.text[:200]}"
            await self._meter(ctx, tier=tier, model=deployment, attempt=attempt, status=status,
                              latency=latency, error=detail)
            if own_key and resp.status_code in (401, 403) and route.org_id:
                await self._key_rejected(route.org_id, deployment.removeprefix(byok.LABEL_PREFIX))
            failures.append(f"{deployment}: HTTP {resp.status_code}")
            if resp.status_code not in RETRYABLE_STATUS and resp.status_code not in PROVIDER_AUTH_STATUS:
                break  # a malformed request will fail on every provider

        raise AllProvidersFailed(tier, failures)

    async def _own_key_chat(self, route: Route, deployment: str, messages: list[dict[str, Any]],
                            params: dict[str, Any]) -> httpx.Response:
        from kritvia_api.services import byok
        provider = deployment.removeprefix(byok.LABEL_PREFIX)
        model, wrapped = next((m, w) for p, m, w in route.keys if p == provider)
        api_key = byok.unwrap_key(self.keys, route.org_id, provider, wrapped)
        return await byok.chat(self._byok, provider, api_key, model, messages, **params)

    async def _key_rejected(self, org_id: uuid.UUID, provider: str) -> None:
        async with tenant_tx(None, "system") as conn:
            await conn.execute(text("SELECT private.ai_key_result(:o, :p, :e)"),
                               {"o": org_id, "p": provider, "e": "the provider rejected this key"})
        self.forget_routes()


def _cost_header(resp: httpx.Response) -> float | None:
    """LiteLLM reports what the call cost in USD on every response; absent for local models."""
    raw = resp.headers.get("x-litellm-response-cost")
    try:
        return float(raw) if raw not in (None, "") else None
    except ValueError:
        return None


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
        native = router.config.provider(deployment) != "litellm"
        # Native providers' error bodies can echo the request (e.g. keyterms with names): status only.
        detail = f"HTTP {resp.status_code}" if native else f"HTTP {resp.status_code}: {resp.text[:200]}"
        await router._meter(ctx, tier=tier, model=deployment, attempt=attempt, status=status,
                            latency=latency, error=detail)
        failures.append(f"{deployment}: HTTP {resp.status_code}")
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
