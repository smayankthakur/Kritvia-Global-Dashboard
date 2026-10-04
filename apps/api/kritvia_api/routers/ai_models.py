"""AI models for an organisation: free models by default, its own keys for paid models.

Members can see the setup; only an owner changes it. Keys are verified with the provider
before they are saved, stored wrapped by the master key, and never returned.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import text

from kritvia_api.deps import Svc, TenantDB, UserId
from kritvia_api.services import byok

router = APIRouter(prefix="/orgs/{org_id}/ai", tags=["ai-models"])

ProviderKey = Literal["openai", "anthropic", "gemini", "groq", "openrouter", "mistral", "cerebras"]

# What the owner sees about the built-in free models (labels only; routing lives in tiers.yaml).
FREE_FAMILIES = [
    {"key": "groq", "label": "Groq", "deployments": ["groq-llama-70b", "groq-llama-8b"], "trains": False},
    {"key": "cerebras", "label": "Cerebras", "deployments": ["cerebras-large", "cerebras-qwen"], "trains": False},
    {"key": "cloudflare", "label": "Cloudflare Workers AI", "deployments": ["cloudflare-llama-70b"], "trains": False},
    {"key": "gemini", "label": "Google Gemini (free tier)", "deployments": ["gemini-flash"], "trains": True},
    {"key": "mistral", "label": "Mistral (free tier)", "deployments": ["mistral-large"], "trains": True},
    {"key": "openrouter", "label": "OpenRouter free models", "deployments": ["openrouter-free"], "trains": True},
    {"key": "local", "label": "Kritvia's own server", "deployments": ["ollama-qwen-7b"], "trains": False},
]


class FreeModelOut(BaseModel):
    key: str
    label: str
    may_train: bool = Field(description="the provider may learn from what it receives (opt-in only)")
    available: bool = Field(description="this server has a key for it")


class ProviderOut(BaseModel):
    key: str
    label: str
    example_model: str
    keys_url: str


class KeyOut(BaseModel):
    provider: str
    label: str
    model: str
    hint: str
    position: int
    last_ok_at: datetime | None
    last_error: str | None


class AiSetupOut(BaseModel):
    can_edit: bool
    allow_training_models: bool
    free_models: list[FreeModelOut]
    providers: list[ProviderOut]
    keys: list[KeyOut]
    ventures_with_google: int = Field(description="businesses where training models stay off (Google connected)")


class SettingsIn(BaseModel):
    allow_training_models: bool


class KeyIn(BaseModel):
    model: str = Field(min_length=1, max_length=120, pattern=r"^[A-Za-z0-9._:/@+-]+$")
    api_key: str | None = Field(default=None, min_length=8, max_length=400,
                                description="omit to change only the model or order of a saved key")
    position: int | None = Field(default=None, ge=0, le=100)


async def _member(db, org_id: uuid.UUID) -> bool:
    row = (await db.execute(text("SELECT :o = ANY (private.member_orgs()), :o = ANY (private.owned_orgs())"),
                            {"o": org_id})).first()
    if not row or not row[0]:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "organisation not found")
    return bool(row[1])


async def _owner(db, org_id: uuid.UUID) -> None:
    if not await _member(db, org_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only an owner can change AI models")


@router.get("", response_model=AiSetupOut)
async def get_setup(org_id: uuid.UUID, db: TenantDB, svc: Svc) -> AiSetupOut:
    can_edit = await _member(db, org_id)
    allow = (await db.execute(text("SELECT allow_training_models FROM org_ai_settings WHERE org_id = :o"),
                              {"o": org_id})).scalar()
    rows = (await db.execute(text(
        "SELECT provider, model, key_hint, position, last_ok_at, last_error FROM org_ai_keys"
        " WHERE org_id = :o ORDER BY position, created_at"), {"o": org_id})).all()
    google = (await db.execute(text(
        "SELECT count(DISTINCT c.venture_id) FROM connectors c WHERE c.org_id = :o AND c.provider = 'google'"
        " AND c.status = 'active'"), {"o": org_id})).scalar()
    cfg = svc.router.config
    free = [FreeModelOut(key=f["key"], label=f["label"], may_train=any(cfg.policies.get(d) == "may_train"
                                                                       for d in f["deployments"]),
                         available=any(d in cfg.policies and cfg.available(d) for d in f["deployments"]))
            for f in FREE_FAMILIES]
    return AiSetupOut(
        can_edit=can_edit, allow_training_models=bool(allow), free_models=free,
        providers=[ProviderOut(key=p.key, label=p.label, example_model=p.example_model, keys_url=p.keys_url)
                   for p in byok.PROVIDERS.values()],
        keys=[KeyOut(provider=r.provider, label=byok.PROVIDERS[r.provider].label, model=r.model, hint=r.key_hint,
                     position=r.position, last_ok_at=r.last_ok_at, last_error=r.last_error) for r in rows],
        ventures_with_google=int(google or 0))


@router.put("/settings", response_model=AiSetupOut)
async def put_settings(org_id: uuid.UUID, body: SettingsIn, user_id: UserId, db: TenantDB, svc: Svc) -> AiSetupOut:
    await _owner(db, org_id)
    await db.execute(text(
        "INSERT INTO org_ai_settings (org_id, allow_training_models, updated_by) VALUES (:o, :a, :u)"
        " ON CONFLICT (org_id) DO UPDATE SET allow_training_models = EXCLUDED.allow_training_models,"
        " updated_by = EXCLUDED.updated_by, updated_at = now()"),
        {"o": org_id, "a": body.allow_training_models, "u": user_id})
    svc.router.forget_routes()
    return await get_setup(org_id, db, svc)


@router.put("/keys/{provider}", response_model=AiSetupOut)
async def put_key(org_id: uuid.UUID, provider: ProviderKey, body: KeyIn, db: TenantDB, svc: Svc) -> AiSetupOut:
    """Adds or replaces the organisation's key for one provider, after a one-line test call."""
    await _owner(db, org_id)
    existing = (await db.execute(text("SELECT position FROM org_ai_keys WHERE org_id = :o AND provider = :p"),
                                 {"o": org_id, "p": provider})).first()
    if body.api_key is None:
        if existing is None:
            raise HTTPException(422, "paste the API key the first time you add this provider")
        await db.execute(text("UPDATE org_ai_keys SET model = :m, position = coalesce(:pos, position),"
                              " updated_at = now() WHERE org_id = :o AND provider = :p"),
                         {"m": body.model, "pos": body.position, "o": org_id, "p": provider})
    else:
        api_key = body.api_key.strip()
        problem = await byok.verify(svc.router._byok, provider, api_key, body.model)
        if problem:
            raise HTTPException(422, f"Not saved: {problem}.")
        await db.execute(text("SELECT private.ai_key_save(:o, :p, :m, :k, :h, :pos)"),
                         {"o": org_id, "p": provider, "m": body.model,
                          "k": byok.wrap_key(svc.keys, org_id, provider, api_key), "h": byok.hint(api_key),
                          "pos": body.position})
    svc.router.forget_routes()
    return await get_setup(org_id, db, svc)


@router.delete("/keys/{provider}", response_model=AiSetupOut)
async def delete_key(org_id: uuid.UUID, provider: ProviderKey, db: TenantDB, svc: Svc) -> AiSetupOut:
    await _owner(db, org_id)
    await db.execute(text("DELETE FROM org_ai_keys WHERE org_id = :o AND provider = :p"), {"o": org_id, "p": provider})
    svc.router.forget_routes()
    return await get_setup(org_id, db, svc)
