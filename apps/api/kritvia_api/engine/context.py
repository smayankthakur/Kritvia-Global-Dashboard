"""Runtime services and the per-run context handed to every step."""
from __future__ import annotations

import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, TypeVar

from pydantic import BaseModel
from sqlalchemy import text

from kritvia_api.db.session import tenant_tx
from kritvia_api.services import llm
from kritvia_api.services.crypto import EnvelopeCrypto, KeyProvider
from kritvia_api.services.model_router import CallContext, ModelRouter, Transcript, embed, transcribe

if TYPE_CHECKING:
    from kritvia_api.engine.dispatch import Dispatcher
    from kritvia_api.engine.tools import ToolRegistry
    from kritvia_api.services.messaging import Messaging
    from kritvia_api.services.sandbox import SandboxClient

T = TypeVar("T", bound=BaseModel)


@dataclass
class Services:
    router: ModelRouter
    keys: KeyProvider
    tools: ToolRegistry
    dispatcher: Dispatcher
    sandbox: SandboxClient
    messaging: Messaging
    google: Any = None
    worker_id: str = field(default_factory=lambda: f"w-{uuid.uuid4().hex[:8]}")


_services: Services | None = None


def get_services() -> Services:
    global _services
    if _services is None:
        from kritvia_api.engine.bootstrap import build_services
        _services = build_services()
    return _services


def set_services(s: Services | None) -> None:
    """Tests and the worker install their own services (fake LLM, inline dispatch)."""
    global _services
    _services = s


@dataclass(frozen=True)
class Business:
    name: str
    city: str
    about: str
    sign_off: str

    @property
    def where(self) -> str:
        return self.city or "India"

    def describe(self) -> str:
        """One line for a system prompt."""
        return f"{self.name} ({self.where})" + (f": {self.about}" if self.about else "")


@dataclass
class RunContext:
    run_id: uuid.UUID
    org_id: uuid.UUID
    venture_id: uuid.UUID
    run_as: uuid.UUID
    workflow: str
    services: Services
    trigger_kind: str = "manual"
    agent: str = "orchestrator"
    notes: list[str] = field(default_factory=list)

    # --- database -----------------------------------------------------------
    @asynccontextmanager
    async def tx(self, agent: str | None = None):
        """A tenant transaction as this venture's agent runtime (RLS applies)."""
        async with tenant_tx(self.run_as, "agent", agent or self.agent) as conn:
            yield conn

    def crypto(self, conn) -> EnvelopeCrypto:
        return EnvelopeCrypto(conn, self.services.keys)

    async def settings(self) -> dict[str, Any]:
        """This workflow's venture-specific settings (workflow_configs.settings)."""
        async with self.tx() as conn:
            row = (await conn.execute(
                text("SELECT settings FROM workflow_configs WHERE venture_id = :v AND workflow = :w"),
                {"v": self.venture_id, "w": self.workflow})).first()
        return dict(row.settings) if row else {}

    async def business(self) -> Business:
        """Who the agents write as: the venture's business profile, with defaults."""
        async with self.tx() as conn:
            row = (await conn.execute(text(
                "SELECT v.name, s.business_name, s.city, s.about, s.sign_off FROM ventures v"
                " LEFT JOIN venture_settings s ON s.venture_id = v.id WHERE v.id = :v"),
                {"v": self.venture_id})).first()
        name = ((row.business_name or row.name) if row else "") or "our team"
        return Business(name=name, city=(row.city if row else None) or "",
                        about=(row.about if row else None) or "",
                        sign_off=(row.sign_off if row else None) or f"Team {name}")

    # --- models -------------------------------------------------------------
    def call_ctx(self, agent: str | None = None) -> CallContext:
        return CallContext(org_id=self.org_id, venture_id=self.venture_id, user_id=self.run_as,
                           actor_type="agent", agent_id=agent or self.agent, workflow=self.workflow)

    async def llm_json(self, *, tier: str, system: str, prompt: str, schema: type[T],
                       sensitive: bool = False) -> T:
        return await llm.complete_json(self.services.router, self.call_ctx(), tier=tier, system=system,
                                       prompt=prompt, schema=schema, sensitive=sensitive)

    async def llm_text(self, *, tier: str, system: str, prompt: str, sensitive: bool = False,
                       max_tokens: int | None = None) -> str:
        return await llm.complete_text(self.services.router, self.call_ctx(), tier=tier, system=system,
                                       prompt=prompt, sensitive=sensitive, max_tokens=max_tokens)

    async def embed(self, texts: list[str], *, sensitive: bool = False) -> list[list[float]]:
        return await embed(self.services.router, self.call_ctx(), texts, sensitive=sensitive)

    async def transcribe(self, audio: bytes, filename: str, *, sensitive: bool = False,
                         hints_for=None, language: str | None = None) -> Transcript:
        return await transcribe(self.services.router, self.call_ctx(), audio, filename, sensitive=sensitive,
                                hints_for=hints_for, language=language)

    # --- tools --------------------------------------------------------------
    async def invoke(self, tool: str, args: dict[str, Any] | None = None, *,
                     approval_id: uuid.UUID | str | None = None) -> dict[str, Any]:
        return await self.services.tools.invoke(self, tool, args or {}, approval_id=approval_id)

    def note(self, message: str) -> None:
        """Non-sensitive line for the run timeline (never put personal data here)."""
        self.notes.append(message[:300])
