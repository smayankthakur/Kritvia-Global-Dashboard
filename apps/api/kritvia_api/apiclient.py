"""The developer API's contract (test report round 2, P16), as one ASGI middleware:

  /v1/...            a stable prefix: /v1/ventures/{v}/leads is /ventures/{v}/leads. Integrations use /v1 and
                     keep working when Kritvia's own app paths change.
  Idempotency-Key    a POST made with an API key (Authorization: Bearer kvk_…) and an Idempotency-Key header
                     runs once: a retry with the same key gets the first response again (header
                     Idempotent-Replayed: true) for 24 hours; the same key with a different request is refused
                     (422); one still running answers 409. Server errors aren't kept, so a retry runs again.
  One error format   under /v1, every error is {"detail": "<one sentence>", "status": <code>} (validation
                     errors also list "errors": [{"field", "problem"}]), instead of FastAPI's list for
                     validation and a string elsewhere.

Everything else passes through untouched (the web app's requests don't use /v1 or API keys).
"""
from __future__ import annotations

import hashlib
import json
import logging
from typing import Any

from sqlalchemy import text

log = logging.getLogger("kritvia.apiclient")

V1 = "/v1"
MAX_KEY = 200
MAX_BODY = 2 * 1024 * 1024        # idempotent requests are JSON; bigger ones aren't kept
MAX_KEEP = 256 * 1024             # the response kept for a replay


def _header(scope, name: bytes) -> str | None:
    for k, v in scope.get("headers", []):
        if k == name:
            return v.decode("latin-1")
    return None


def tidy_error(status: int, body: bytes) -> bytes:
    """{"detail": "...", "status": n[, "errors": [...]]} from whatever FastAPI answered."""
    try:
        data = json.loads(body or b"{}")
    except ValueError:
        return json.dumps({"detail": body.decode("utf-8", "replace")[:500] or "error", "status": status}).encode()
    detail: Any = data.get("detail") if isinstance(data, dict) else data
    out: dict[str, Any] = {"status": status}
    if isinstance(detail, list):
        errors = []
        for e in detail:
            if isinstance(e, dict):
                field = ".".join(str(p) for p in e.get("loc", []) if p not in ("body", "query", "path"))
                errors.append({"field": field or None, "problem": str(e.get("msg", ""))})
        out["errors"] = errors
        out["detail"] = "; ".join(f"{e['field']}: {e['problem']}" if e["field"] else e["problem"] for e in errors) or "invalid request"
    else:
        out["detail"] = str(detail if detail is not None else "error")
    return json.dumps(out, ensure_ascii=False).encode()


class ApiClientMiddleware:
    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path: str = scope.get("path", "")
        v1 = path == V1 or path.startswith(V1 + "/")
        if v1:
            scope = dict(scope)
            scope["path"] = path[len(V1):] or "/"
            raw = scope.get("raw_path")
            if isinstance(raw, bytes) and raw.startswith(V1.encode()):
                scope["raw_path"] = raw[len(V1):] or b"/"
        auth = _header(scope, b"authorization") or ""
        key = _header(scope, b"idempotency-key")
        if scope.get("method") == "POST" and key and auth.startswith("Bearer kvk_"):
            if len(key) > MAX_KEY:
                return await _json(send, 422, {"detail": "Idempotency-Key is too long (200 characters at most)", "status": 422})
            return await self._idempotent(scope, receive, send, auth, key, v1)
        if v1:
            return await self.app(scope, receive, _errors_tidied(send))
        return await self.app(scope, receive, send)

    async def _idempotent(self, scope, receive, send, auth: str, key: str, v1: bool):
        from kritvia_api.db.session import tenant_tx
        body = b""
        more = True
        while more:
            msg = await receive()
            body += msg.get("body", b"")
            more = msg.get("more_body", False)
            if len(body) > MAX_BODY:
                return await _json(send, 413, {"detail": "request body too large for an idempotent request", "status": 413})
        who = hashlib.sha256(auth.removeprefix("Bearer ").encode()).hexdigest()
        req_hash = hashlib.sha256(scope["path"].encode() + b"\n" + body).hexdigest()
        async with tenant_tx(None, "system") as conn:
            st = (await conn.execute(text("SELECT * FROM private.idem_begin(:s, :k, :m, :p, :h)"),
                                     {"s": who, "k": key, "m": "POST", "p": scope["path"][:500], "h": req_hash})).first()
        if st.state == "busy":
            return await _json(send, 409, {"detail": "a request with this Idempotency-Key is still being processed", "status": 409})
        if st.state == "mismatch":
            return await _json(send, 422, {"detail": "this Idempotency-Key was already used for a different request", "status": 422})
        if st.state == "replay":
            headers = [(b"content-type", (st.content_type or "application/json").encode()),
                       (b"idempotent-replayed", b"true")]
            payload = bytes(st.body or b"")
            await send({"type": "http.response.start", "status": st.status, "headers": headers})
            await send({"type": "http.response.body", "body": payload})
            return

        sent = False

        async def replay_receive():
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        captured: dict[str, Any] = {"status": 500, "headers": [], "body": b""}
        out = _errors_tidied(send) if v1 else send

        async def capture(message):
            if message["type"] == "http.response.start":
                captured["status"] = message["status"]
                captured["headers"] = message.get("headers", [])
            elif message["type"] == "http.response.body" and len(captured["body"]) <= MAX_KEEP:
                captured["body"] += message.get("body", b"")
            await out(message)

        try:
            await self.app(scope, replay_receive, capture)
        finally:
            status = captured["status"]
            ctype = next((v.decode("latin-1") for k, v in captured["headers"] if k == b"content-type"), "application/json")
            body_kept = captured["body"] if len(captured["body"]) <= MAX_KEEP else None
            if v1 and status >= 400 and body_kept is not None and "json" in ctype:
                body_kept = tidy_error(status, body_kept)
            try:
                async with tenant_tx(None, "system") as conn:
                    if status >= 500:
                        await conn.execute(text("SELECT private.idem_abort(:s, :k)"), {"s": who, "k": key})
                    else:
                        await conn.execute(text("SELECT private.idem_finish(:s, :k, :st, :b, :t)"),
                                           {"s": who, "k": key, "st": status, "t": ctype,
                                            "b": body_kept if body_kept is not None else json.dumps(
                                                {"detail": "already done; that response was too large to keep", "status": status}).encode()})
            except Exception:  # noqa: BLE001 - the request itself was answered
                log.exception("could not record an idempotent response")


def _errors_tidied(send):
    """Rewrites JSON error bodies (status >= 400) into the one error format."""
    state: dict[str, Any] = {"start": None, "body": b""}

    async def wrapped(message):
        if message["type"] == "http.response.start":
            ctype = next((v for k, v in message.get("headers", []) if k == b"content-type"), b"")
            if message["status"] >= 400 and b"json" in ctype:
                state["start"] = message
                return
            await send(message)
            return
        if message["type"] == "http.response.body" and state["start"] is not None:
            state["body"] += message.get("body", b"")
            if message.get("more_body"):
                return
            start = state["start"]
            new = tidy_error(start["status"], state["body"])
            headers = [(k, v) for k, v in start.get("headers", []) if k != b"content-length"]
            headers.append((b"content-length", str(len(new)).encode()))
            await send({**start, "headers": headers})
            await send({"type": "http.response.body", "body": new})
            return
        await send(message)

    return wrapped


async def _json(send, status: int, data: dict) -> None:
    body = json.dumps(data).encode()
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
    await send({"type": "http.response.body", "body": body})
