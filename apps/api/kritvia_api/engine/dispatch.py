"""How a run gets onto a worker.

ArqDispatcher   production: enqueue on Valkey; arq workers execute.
InlineDispatcher tests and single-process dev: execute in-process.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Protocol

log = logging.getLogger("kritvia.dispatch")


class Dispatcher(Protocol):
    async def enqueue_run(self, run_id: uuid.UUID) -> None: ...


class InlineDispatcher:
    """await=True runs to completion before returning (deterministic tests);
    await=False schedules a background task (local dev without Valkey)."""

    def __init__(self, wait: bool = True) -> None:
        self.wait = wait
        self._tasks: set[asyncio.Task] = set()
        self.services = None  # set by bootstrap once Services exists

    async def enqueue_run(self, run_id: uuid.UUID) -> None:
        from kritvia_api.engine.runner import advance_run

        if self.services is None:
            raise RuntimeError("InlineDispatcher is not bound to services")
        if self.wait:
            await advance_run(self.services, run_id)
            return
        task = asyncio.create_task(advance_run(self.services, run_id))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def drain(self) -> None:
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)


class ArqDispatcher:
    def __init__(self, redis_url: str) -> None:
        self.redis_url = redis_url
        self._pool = None
        self._lock = asyncio.Lock()

    async def _get_pool(self):
        from arq import create_pool
        from arq.connections import RedisSettings

        async with self._lock:
            if self._pool is None:
                self._pool = await create_pool(RedisSettings.from_dsn(self.redis_url))
        return self._pool

    async def enqueue_run(self, run_id: uuid.UUID) -> None:
        pool = await self._get_pool()
        # One queued job per run at a time; the sweeper recovers anything missed.
        await pool.enqueue_job("execute_run", str(run_id), _job_id=f"run:{run_id}")

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.aclose()
            self._pool = None
