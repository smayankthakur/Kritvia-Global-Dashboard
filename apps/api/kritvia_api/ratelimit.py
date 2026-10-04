"""Fixed-window rate limiting for unauthenticated and auth endpoints.

Uses Valkey when the stack runs with a queue (shared across API processes),
otherwise an in-process window (single-process dev / tests).
"""
from __future__ import annotations

import time

from fastapi import HTTPException, Request, status

from kritvia_api.config import get_settings


def client_ip(request: Request) -> str:
    """Client address for rate limiting. A forwarded-IP header is only trusted when
    CLIENT_IP_HEADER names it — set it only when the API is reachable exclusively
    through that proxy (Cloudflare Tunnel: cf-connecting-ip; the web BFF forwards it)."""
    header = get_settings().client_ip_header
    if header:
        value = request.headers.get(header)
        if value:
            return value.split(",")[0].strip()[:64]
    return request.client.host if request.client else "unknown"


class RateLimiter:
    def __init__(self) -> None:
        self._mem: dict[str, tuple[int, int]] = {}
        self._redis = None

    async def _backend(self):
        s = get_settings()
        if s.dispatch_mode != "arq":
            return None
        if self._redis is None:
            import redis.asyncio as redis
            self._redis = redis.from_url(s.redis_url)
        return self._redis

    async def hit(self, key: str, per_minute: int) -> None:
        await self.hit_window(key, per_minute, 60)

    async def hit_window(self, key: str, limit: int, seconds: int) -> None:
        """Counts one request against `limit` per fixed window of `seconds`; 429 beyond it."""
        window = int(time.time() // seconds)
        k = f"rl:{key}:{seconds}:{window}"
        backend = await self._backend()
        if backend is not None:
            n = await backend.incr(k)
            if n == 1:
                await backend.expire(k, seconds + 30)
        else:
            w, n = self._mem.get(k, (window, 0))
            n += 1
            self._mem[k] = (window, n)
            if len(self._mem) > 50_000:  # drop old windows
                now = time.time()
                self._mem = {kk: v for kk, v in self._mem.items() if (v[0] + 2) * int(kk.split(":")[-2]) > now}
        if n > limit:
            retry = seconds - int(time.time()) % seconds
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS,
                                "too many attempts, try again later" if seconds > 60 else "too many requests, slow down",
                                headers={"Retry-After": str(retry)})


limiter = RateLimiter()
