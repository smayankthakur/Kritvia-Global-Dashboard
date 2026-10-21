"""Fixes from the 21 Oct 2026 pre-launch audit: campaign emails carry one-click unsubscribe headers (sent through
the business's Gmail), and uploaded images are opened only with the formats uploads allow."""
from __future__ import annotations

import base64
import email
import io
import json
import uuid

import httpx
import pytest

from kritvia_api.services import campaigns as cs
from kritvia_api.services import textextract
from kritvia_api.services.google import GoogleClient

pytestmark = pytest.mark.asyncio


async def test_campaign_email_has_one_click_unsubscribe():
    v = uuid.uuid4()
    h = cs.unsubscribe_headers(v, "bina@example.com")
    assert h["List-Unsubscribe-Post"] == "List-Unsubscribe=One-Click"
    assert h["List-Unsubscribe"].startswith("<") and "/api/unsubscribe/campaign?t=" in h["List-Unsubscribe"]
    assert cs.unsubscribe_token(v, "bina@example.com") in h["List-Unsubscribe"]
    sent = {}

    def gmail(request: httpx.Request) -> httpx.Response:
        sent["raw"] = base64.urlsafe_b64decode(json.loads(request.content)["raw"])
        return httpx.Response(200, json={"id": "m1", "threadId": "t1"})
    g = GoogleClient("id", "secret", "https://x/cb", transport=httpx.MockTransport(gmail))
    await g.send_email("tok", to="bina@example.com", subject="Diwali offer", body="Hi", headers=h)
    msg = email.message_from_bytes(sent["raw"])
    assert msg["List-Unsubscribe"] == h["List-Unsubscribe"] and msg["List-Unsubscribe-Post"] == h["List-Unsubscribe-Post"]


def test_images_open_only_in_allowed_formats():
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (4, 4)).save(buf, format="PNG")
    assert textextract._open_image(Image, buf.getvalue()).format == "PNG"
    gif = io.BytesIO()
    Image.new("RGB", (4, 4)).save(gif, format="GIF")
    with pytest.raises(textextract.ExtractionError):
        textextract._open_image(Image, gif.getvalue())


async def test_product_email_unsubscribe_header_stays_plain():
    from kritvia_api.services.mailer import get_mailer
    url = "https://app.sitelytc.com/api/unsubscribe?t=" + "A" * 120
    out = get_mailer().outbox
    before = len(out)
    await get_mailer().send("someone@example.com", "Tips", "Hello", unsubscribe_url=url)
    raw = out[before:][0].as_bytes()
    assert f"List-Unsubscribe: <{url}>".encode() in raw and b"=?utf-8?" not in raw.split(b"\n\n")[0]


async def test_ai_kill_switch_pauses_every_call_and_runs_retry(monkeypatch, services):
    from kritvia_api.config import get_settings
    from kritvia_api.engine.runner import passing
    from kritvia_api.services.model_router import AiPaused, CallContext
    monkeypatch.setattr(get_settings(), "ai_paused", True)
    ctx = CallContext(org_id=uuid.uuid4(), venture_id=uuid.uuid4(), user_id=None, workflow="test", actor_type="system")
    calls = []

    async def meter(_ctx, **row):
        calls.append(row)
    monkeypatch.setattr(services.router, "_meter", meter)
    with pytest.raises(AiPaused):
        await services.router.chat(ctx, tier="plan", messages=[{"role": "user", "content": "hi"}])
    assert calls and calls[0]["status"] == "blocked"
    assert passing(AiPaused("paused"))


async def test_ai_spend_alert_tells_the_team(world, services, monkeypatch):
    import asyncpg

    from conftest import ADMIN_DSN
    from kritvia_api.config import get_settings
    from kritvia_api.services import watchdog
    from kritvia_api.services.mailer import get_mailer
    monkeypatch.setattr(get_settings(), "staff_emails", "spend@kritvia.test")
    monkeypatch.setattr(get_settings(), "ai_daily_spend_alert_usd", 5.0)
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute("DELETE FROM platform_alerts WHERE key = 'spend'")
        org, v = uuid.UUID(world["org"]), uuid.UUID(world["site"])
        row = await conn.fetchval("INSERT INTO model_calls (org_id, venture_id, tier, status, cost_usd)"
                                  " VALUES ($1, $2, 'plan', 'ok', 999) RETURNING id", org, v)
        out = get_mailer().outbox
        before = len(out)
        found = await watchdog.check(services, spend_check=True)
        assert "spend" in found and "AI_PAUSED" in found["spend"]
        subjects = [m["Subject"] for m in out[before:] if m["To"] == "spend@kritvia.test"]
        assert subjects.count("Kritvia: AI spending is high") == 1
        await conn.execute("DELETE FROM model_calls WHERE id = $1", row)
        assert "spend" not in await watchdog.check(services, spend_check=True)
    finally:
        await conn.execute("DELETE FROM platform_alerts WHERE key = 'spend'")
        await conn.close()
