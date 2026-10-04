"""The limiter's long windows: daily caps on sign-in codes, hourly cap on password guesses."""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from kritvia_api.ratelimit import RateLimiter

pytestmark = pytest.mark.asyncio


async def test_window_allows_the_limit_then_refuses_until_it_rolls():
    rl = RateLimiter()
    for _ in range(30):
        await rl.hit_window("email-verify-day:a@example.com", 30, 86400)
    with pytest.raises(HTTPException) as exc:
        await rl.hit_window("email-verify-day:a@example.com", 30, 86400)
    assert exc.value.status_code == 429 and int(exc.value.headers["Retry-After"]) <= 86400
    # other addresses and the per-minute limiter are unaffected
    await rl.hit_window("email-verify-day:b@example.com", 30, 86400)
    await rl.hit("auth-ip:2001:db8::1", per_minute=5)
