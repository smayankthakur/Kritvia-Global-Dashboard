"""Refuses oversized request bodies before anything buffers or parses them.

Multipart forms are parsed (and spooled to disk) before an endpoint's own checks run, so a
limit inside the endpoint is too late against a flood of large anonymous posts. This ASGI
middleware answers 413 on Content-Length at once, and stops a body without a length as soon
as it passes the limit.
"""
from __future__ import annotations

import json

# Longest prefix wins. Webhooks carry small JSON; the public upload link carries a few scans.
LIMITS: tuple[tuple[str, int], ...] = (
    ("/hooks/", 256 * 1024),
    ("/public/", 1024 * 1024),
    ("/public/billing/", 256 * 1024),
    ("/public/support", 64 * 1024),
    ("/public/upload/", 60 * 1024 * 1024),
    ("/auth/", 64 * 1024),
)
DEFAULT_LIMIT = 60 * 1024 * 1024


def limit_for(path: str) -> int:
    best = ("", DEFAULT_LIMIT)
    for prefix, n in LIMITS:
        if path.startswith(prefix) and len(prefix) > len(best[0]):
            best = (prefix, n)
    return best[1]


class TooLarge(Exception):
    pass


class BodyLimitMiddleware:
    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] in ("GET", "HEAD", "OPTIONS"):
            return await self.app(scope, receive, send)
        limit = limit_for(scope.get("path", ""))
        for name, value in scope.get("headers", []):
            if name == b"content-length":
                try:
                    if int(value) > limit:
                        return await _reject(send)
                except ValueError:
                    return await _reject(send, 400, "bad content-length")
        seen = 0
        started = False

        async def counted_receive():
            nonlocal seen
            msg = await receive()
            if msg["type"] == "http.request":
                seen += len(msg.get("body", b""))
                if seen > limit:
                    raise TooLarge
            return msg

        async def tracked_send(msg):
            nonlocal started
            if msg["type"] == "http.response.start":
                started = True
            await send(msg)

        try:
            await self.app(scope, counted_receive, tracked_send)
        except TooLarge:
            if not started:
                await _reject(send)


async def _reject(send, status: int = 413, detail: str = "request body too large") -> None:
    body = json.dumps({"detail": detail}).encode()
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
    await send({"type": "http.response.body", "body": body})
