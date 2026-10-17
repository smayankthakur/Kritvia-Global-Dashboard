"""How a run gets onto a worker.

ArqDispatcher   production: enqueue on Valkey; arq workers execute.
InlineDispatcher tests and single-process dev: execute in-process.

Priority processing: runs of organisations whose plan includes it (Scale, Enterprise) go to their
own queue, served by a reserved worker (`worker-priority` in docker-compose), so they never wait
behind other businesses' runs. The reserved worker keeps a heartbeat key in Valkey; while it is
missing (worker down or not deployed) priority runs simply use the shared queue.
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


PRIORITY_QUEUE = "arq:priority"
PRIORITY_HEARTBEAT = "kritvia:priority-worker:alive"


async def run_has_priority(run_id: uuid.UUID) -> bool:
    """True when the run's organisation is on a plan with priority processing."""
    from sqlalchemy import text

    from kritvia_api.db.session import tenant_tx
    from kritvia_api.plans import plan as plan_of

    async with tenant_tx(None, "system") as conn:
        code = (await conn.execute(text("SELECT private.run_plan(:r)"), {"r": run_id})).scalar()
    return "priority_processing" in plan_of(code).extras if code else False


class ArqDispatcher:
    def __init__(self, redis_url: str) -> None:
        self.redis_url = redis_url
        self._pool = None
        self._lock = asyncio.Lock()
        self._alive: tuple[float, bool] = (0.0, False)

    async def _get_pool(self):
        from arq import create_pool
        from arq.connections import RedisSettings

        async with self._lock:
            if self._pool is None:
                self._pool = await create_pool(RedisSettings.from_dsn(self.redis_url))
        return self._pool

    async def _priority_worker_alive(self, pool) -> bool:
        import time
        checked, alive = self._alive
        if time.monotonic() - checked < 15:
            return alive
        try:
            alive = bool(await pool.exists(PRIORITY_HEARTBEAT))
        except Exception:  # noqa: BLE001
            alive = False
        self._alive = (time.monotonic(), alive)
        return alive

    async def enqueue_run(self, run_id: uuid.UUID) -> None:
        pool = await self._get_pool()
        queue = None
        try:
            if await self._priority_worker_alive(pool) and await run_has_priority(run_id):
                queue = PRIORITY_QUEUE
        except Exception:  # noqa: BLE001  never let the choice of queue stop a run
            log.warning("priority check failed for run %s", run_id, exc_info=True)
        # One queued job per run at a time; the sweeper recovers anything missed.
        if queue:
            await pool.enqueue_job("execute_run", str(run_id), _job_id=f"run:{run_id}", _queue_name=queue)
        else:
            await pool.enqueue_job("execute_run", str(run_id), _job_id=f"run:{run_id}")

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.aclose()
            self._pool = None
