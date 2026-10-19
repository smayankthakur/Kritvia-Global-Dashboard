"""Where a business can post, and posting there: its Google Business Profile ('What's new' updates) and its
Facebook Page. Used by the Social agent (workflows/social.py) after a yes."""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import text

from kritvia_api.services import facebook, gbp


async def channels(services, conn, venture_id: uuid.UUID) -> dict[str, str]:
    """{channel: what it is} for the places this business can post to now."""
    out: dict[str, str] = {}
    if await gbp.has_access(conn, venture_id):
        s = (await conn.execute(text("SELECT gbp_location, gbp_title FROM review_settings WHERE venture_id = :v"),
                                {"v": venture_id})).first()
        if s and s.gbp_location:
            out["google"] = f"Google profile ({s.gbp_title or 'your listing'})"
    fb = (await conn.execute(text("SELECT account_email FROM connectors WHERE venture_id = :v"
                                  " AND provider = 'facebook_page' AND status = 'active'"), {"v": venture_id})).first()
    if fb:
        out["facebook"] = f"Facebook Page ({fb.account_email or 'connected'})"
    return out


async def publish(ctx, post_id: uuid.UUID, body: str, wanted: list[str]) -> dict[str, Any]:
    """Posts to each channel; records what happened per channel. One channel failing doesn't stop the other."""
    body = body.strip()[:1500]
    results: dict[str, dict[str, Any]] = {}
    for ch in [c for c in ("google", "facebook") if c in wanted]:
        try:
            if ch == "google":
                async with ctx.tx() as conn:
                    prof = await gbp.profile(ctx.services, conn, ctx.venture_id)
                if not prof.location:
                    raise gbp.NotConnected("choose the business's Google listing on the Reviews page")
                got = await ctx.services.google.gbp_post(prof.token, prof.location, body)
                results[ch] = {"ok": True, "id": str(got.get("name") or "")[:200]}
            else:
                async with ctx.tx() as conn:
                    pg = await facebook.page(ctx.services, conn, ctx.venture_id)
                if pg is None:
                    raise facebook.FacebookError("connect the Facebook Page on the Marketing page")
                results[ch] = {"ok": True, "id": await facebook.post(pg[0], pg[1], body)}
        except Exception as exc:  # noqa: BLE001 - recorded per channel and shown on the Marketing page
            results[ch] = {"ok": False, "error": str(exc)[:300]}
    ok = [c for c, r in results.items() if r["ok"]]
    status = "posted" if ok and len(ok) == len(results) else "partly_posted" if ok else "failed"
    import json
    async with ctx.tx() as conn:
        await conn.execute(text(
            "UPDATE social_posts SET status = :s, results = CAST(:r AS jsonb), body = :b,"
            " posted_at = CASE WHEN :ok THEN now() END WHERE id = :id AND venture_id = :v"),
            {"s": status, "r": json.dumps(results), "b": body or "-", "ok": bool(ok), "id": post_id,
             "v": ctx.venture_id})
    return {"status": status, "posted_to": ok,
            "failed": {c: r["error"] for c, r in results.items() if not r["ok"]}}
