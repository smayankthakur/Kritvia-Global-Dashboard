"""Tenant-scoped database sessions.

Every request that touches tenant data runs inside ONE transaction whose first
statement pins the request context with set_config(..., is_local => true).
RLS policies read that context, so the database itself enforces isolation.
Because the setting is transaction-local, a pooled connection can never leak
one user's context into another request.
"""
from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Literal

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine

from kritvia_api.config import get_settings

ActorType = Literal["user", "agent", "system"]

_engine: AsyncEngine | None = None


def get_engine() -> AsyncEngine:
    global _engine
    if _engine is None:
        _engine = create_async_engine(get_settings().database_url, pool_size=10, pool_pre_ping=True)
    return _engine


async def dispose_engine() -> None:
    global _engine
    if _engine is not None:
        await _engine.dispose()
        _engine = None


@asynccontextmanager
async def tenant_tx(
    user_id: uuid.UUID | None,
    actor_type: ActorType = "user",
    agent_id: str | None = None,
) -> AsyncIterator[AsyncConnection]:
    async with get_engine().begin() as conn:
        await conn.execute(
            text(
                "SELECT set_config('app.user_id', :uid, true),"
                "       set_config('app.actor_type', :actor, true),"
                "       set_config('app.agent_id', :agent, true)"
            ),
            {"uid": str(user_id) if user_id else "", "actor": actor_type, "agent": agent_id or ""},
        )
        yield conn
