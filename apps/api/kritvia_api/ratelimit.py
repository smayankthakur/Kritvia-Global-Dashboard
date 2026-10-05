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


class SignInGuard:
    """Progressive lock-out after repeated failed sign-ins for one email address.

    After FREE_TRIES consecutive failures, further attempts for that address are refused for
    1, 2, 4 … up to 60 minutes (doubling with each further failure); a success clears it. It
    applies the same way whether or not the address has an account, so the answer never
    reveals who is registered, and the lock is on attempts, not on the account: the real owner
    can still sign in with Google. Works with Valkey/Redis in production and memory in tests.
    """

    FREE_TRIES = 5
    MAX_LOCK_S = 3600
    MEMORY_S = 24 * 3600

    def __init__(self) -> None:
        self._mem: dict[str, tuple[int, float]] = {}   # key -> (failures, locked_until)

    @staticmethod
    def _key(email: str) -> str:
        return f"signin-fail:{email.strip().lower()}"

    def lock_seconds(self, failures: int) -> int:
        if failures < self.FREE_TRIES:
            return 0
        return min(60 * 2 ** (failures - self.FREE_TRIES), self.MAX_LOCK_S)

    async def _get(self, key: str) -> tuple[int, float]:
        backend = await limiter._backend()
        if backend is None:
            return self._mem.get(key, (0, 0.0))
        raw = await backend.hmget(key, "n", "until")
        return int(raw[0] or 0), float(raw[1] or 0)

    async def check(self, email: str) -> None:
        """429 while the address is locked."""
        _, until = await self._get(self._key(email))
        left = int(until - time.time())
        if left > 0:
            mins = max(1, (left + 59) // 60)
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS,
                                f"too many failed attempts; try again in {mins} minute{'s' if mins != 1 else ''}",
                                headers={"Retry-After": str(left)})

    async def failed(self, email: str) -> int:
        """Records a failure; returns the number of consecutive failures."""
        key = self._key(email)
        n, _ = await self._get(key)
        n += 1
        until = time.time() + self.lock_seconds(n)
        backend = await limiter._backend()
        if backend is None:
            self._mem[key] = (n, until)
            if len(self._mem) > 50_000:
                now = time.time()
                self._mem = {k: v for k, v in self._mem.items() if v[1] > now - self.MEMORY_S}
        else:
            await backend.hset(key, mapping={"n": n, "until": until})
            await backend.expire(key, self.MEMORY_S)
        return n

    async def succeeded(self, email: str) -> None:
        key = self._key(email)
        backend = await limiter._backend()
        if backend is None:
            self._mem.pop(key, None)
        else:
            await backend.delete(key)


signin_guard = SignInGuard()
