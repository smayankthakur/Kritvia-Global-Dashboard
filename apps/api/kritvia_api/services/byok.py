"""Bring your own key: an organisation's own API keys for paid models.

Every provider here offers an OpenAI-compatible chat endpoint, so one call shape serves all.
Base URLs are fixed in code (never taken from the customer), keys are wrapped by the master
key with the organisation and provider as associated data, and calls on them are billed by
the provider to the customer, so they do not count against the plan's hosted-AI allowance.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

import httpx

from kritvia_api.services.crypto import KeyProvider


@dataclass(frozen=True)
class ByokProvider:
    key: str
    label: str
    base_url: str
    example_model: str
    keys_url: str


PROVIDERS: dict[str, ByokProvider] = {p.key: p for p in (
    ByokProvider("openai", "OpenAI", "https://api.openai.com/v1", "gpt-5-mini",
                 "https://platform.openai.com/api-keys"),
    ByokProvider("anthropic", "Anthropic (Claude)", "https://api.anthropic.com/v1", "claude-sonnet-4-5",
                 "https://console.anthropic.com/settings/keys"),
    ByokProvider("gemini", "Google Gemini (paid)", "https://generativelanguage.googleapis.com/v1beta/openai",
                 "gemini-3.5-flash", "https://aistudio.google.com/apikey"),
    ByokProvider("groq", "Groq", "https://api.groq.com/openai/v1", "openai/gpt-oss-120b",
                 "https://console.groq.com/keys"),
    ByokProvider("openrouter", "OpenRouter", "https://openrouter.ai/api/v1", "anthropic/claude-sonnet-4.5",
                 "https://openrouter.ai/settings/keys"),
    ByokProvider("mistral", "Mistral", "https://api.mistral.ai/v1", "mistral-large-latest",
                 "https://console.mistral.ai/api-keys"),
    ByokProvider("cerebras", "Cerebras", "https://api.cerebras.ai/v1", "gpt-oss-120b",
                 "https://cloud.cerebras.ai/"),
)}

LABEL_PREFIX = "byok:"
# Tiers that never use a customer key: sensitive work stays on our own servers, and embeddings
# and speech run on fixed deployments so search indexes stay consistent.
NO_BYOK_TIERS = frozenset({"private", "embed", "speech", "dictation"})


def label(provider: str) -> str:
    return f"{LABEL_PREFIX}{provider}"


def all_labels() -> list[str]:
    return [label(p) for p in PROVIDERS]


def _context(org_id: uuid.UUID, provider: str) -> bytes:
    return f"kritvia-byok|{org_id}|{provider}".encode()


def wrap_key(keys: KeyProvider, org_id: uuid.UUID, provider: str, api_key: str) -> bytes:
    return keys.wrap(api_key.encode(), _context(org_id, provider))


def unwrap_key(keys: KeyProvider, org_id: uuid.UUID, provider: str, wrapped: bytes) -> str:
    return keys.unwrap(bytes(wrapped), _context(org_id, provider)).decode()


def hint(api_key: str) -> str:
    return "…" + api_key.strip()[-4:]


def _clean(provider: str, params: dict) -> dict:
    out = dict(params)
    if provider == "anthropic":
        # Anthropic's OpenAI-compatible endpoint has no JSON mode; the prompt already asks for JSON.
        out.pop("response_format", None)
    return out


async def chat(client: httpx.AsyncClient, provider: str, api_key: str, model: str,
               messages: list[dict], **params) -> httpx.Response:
    p = PROVIDERS[provider]
    return await client.post(f"{p.base_url}/chat/completions",
                             headers={"Authorization": f"Bearer {api_key}"},
                             json={"model": model, "messages": messages, **_clean(provider, params)})


async def verify(client: httpx.AsyncClient, provider: str, api_key: str, model: str) -> str | None:
    """None if the key can use the model; otherwise a short reason to show the owner."""
    try:
        r = await chat(client, provider, api_key, model, [{"role": "user", "content": "Reply with OK."}],
                       max_tokens=16)
    except httpx.TransportError as exc:
        return f"could not reach {PROVIDERS[provider].label} ({type(exc).__name__})"
    if r.status_code == 200:
        return None
    if r.status_code in (401, 403):
        return "the provider rejected this key"
    if r.status_code in (400, 404, 422):
        return "this key cannot use that model; check the model name"
    if r.status_code == 429:
        return "the key works but is out of credit or rate-limited"
    return f"the provider answered HTTP {r.status_code}"
