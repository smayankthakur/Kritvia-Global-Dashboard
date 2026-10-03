"""Web push: subscribe a browser, get told when a draft needs a decision, unsubscribe."""
from __future__ import annotations

import asyncio

import pytest

from kritvia_api.config import get_settings
from kritvia_api.services import push
from test_inbox_assistant import SUPPORT_MAIL, script_inbox

pytestmark = pytest.mark.asyncio

SUB = {"endpoint": "https://push.example.com/send/abc", "keys": {"p256dh": "BNc-p256dh", "auth": "auth-secret"},
       "user_agent": "Chrome on Android"}


async def test_subscribe_notify_unsubscribe(world, client, monkeypatch, fake_llm):
    mayank, v = world["mayank"], world["site"]
    assert (await mayank.get("/me/push")).json() == {"enabled": False, "public_key": None, "subscribed": 0}
    assert (await mayank.post("/me/push", json=SUB)).status_code == 503

    monkeypatch.setattr(get_settings(), "vapid_public_key", "BPUBLIC")
    monkeypatch.setattr(get_settings(), "vapid_private_key", "private")
    sent: list[tuple[str, dict, dict]] = []
    monkeypatch.setattr(push, "_send", lambda endpoint, keys, body: sent.append((endpoint, keys, body)) or True)

    r = await mayank.post("/me/push", json=SUB)
    assert r.status_code == 201 and r.json() == {"enabled": True, "public_key": "BPUBLIC", "subscribed": 1}
    assert (await mayank.post("/me/push", json={**SUB, "endpoint": "http://insecure"})).status_code == 422
    # a viewer in the same org cannot decide, so is not told
    assert (await world["vera"].post("/me/push", json={**SUB, "endpoint": "https://push.example.com/send/vera"})).status_code == 201

    await mayank.put(f"/ventures/{v}/workflow-configs/inbox_assistant", json={"enabled": True, "settings": {}})
    script_inbox(fake_llm)
    run = await mayank.post(f"/ventures/{v}/runs", json={"workflow": "inbox_assistant", "input": SUPPORT_MAIL})
    assert run.status_code == 201, run.text
    for _ in range(20):
        if sent:
            break
        await asyncio.sleep(0.05)
    assert [s[0] for s in sent] == [SUB["endpoint"]]
    body = sent[0][2]
    assert body["title"] == "A draft needs your yes" and body["url"] == f"/v/{v}/board" and sent[0][1]["auth"] == "auth-secret"

    t = await mayank.post("/me/push/test")
    assert t.status_code == 202 and t.json() == {"sent": 1, "browsers": 1}
    assert (await mayank.post("/me/push/unsubscribe", json={"endpoint": SUB["endpoint"]})).json()["subscribed"] == 0
    assert (await world["vera"].post("/me/push/unsubscribe", json={"endpoint": "https://push.example.com/send/vera"})).status_code == 200
