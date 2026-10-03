"""Web push: "a draft needs your yes" on the owner's phone or laptop, even with the tab closed.

Subscriptions are per browser (push_subscriptions). Sending runs in a thread after the
approval is committed and never blocks or fails the run; a subscription that fails five
times is skipped until the browser re-subscribes.
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid

from sqlalchemy import text

from kritvia_api.config import get_settings
from kritvia_api.db.session import tenant_tx

log = logging.getLogger(__name__)


def enabled() -> bool:
    s = get_settings()
    return bool(s.vapid_public_key and s.vapid_private_key)


def _send(endpoint: str, keys: dict, body: dict) -> bool:
    from pywebpush import WebPushException, webpush
    s = get_settings()
    try:
        webpush(subscription_info={"endpoint": endpoint, "keys": keys}, data=json.dumps(body),
                vapid_private_key=s.vapid_private_key, vapid_claims={"sub": s.vapid_subject}, ttl=3600)
        return True
    except WebPushException as exc:
        log.info("push failed: %s", str(exc)[:120])
        return False


async def notify_approval(approval_id: uuid.UUID, *, title: str, venture_id: uuid.UUID, agent: str) -> int:
    """Pushes to every member who can decide this approval. Returns the number delivered."""
    if not enabled():
        return 0
    async with tenant_tx(None, "system") as conn:
        targets = (await conn.execute(text("SELECT * FROM private.approval_push_targets(:a)"), {"a": approval_id})).all()
    if not targets:
        return 0
    body = {"title": "A draft needs your yes", "body": title[:120], "tag": f"approval-{approval_id}",
            "url": f"/v/{venture_id}/board", "agent": agent}
    results = await asyncio.gather(*(asyncio.to_thread(_send, t.endpoint, dict(t.keys), body) for t in targets))
    async with tenant_tx(None, "system") as conn:
        for t, ok in zip(targets, results, strict=True):
            await conn.execute(text("SELECT private.push_result(:i, :ok)"), {"i": t.subscription_id, "ok": ok})
    return sum(1 for ok in results if ok)
