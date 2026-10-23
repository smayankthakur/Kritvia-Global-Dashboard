"""QR sign-in between devices (both ways), and the signed-in devices list."""
from __future__ import annotations

import pytest

from conftest import make_actor
from kritvia_api.routers.device_link import device_label

pytestmark = pytest.mark.asyncio
PHONE = {"user-agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36"}
LAPTOP = {"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36"}


async def test_device_label():
    assert device_label(PHONE["user-agent"]) == "Chrome on Android"
    assert device_label(LAPTOP["user-agent"]) == "Chrome on Windows"
    assert device_label("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1") == "Safari on iPhone"
    assert device_label(None) == "Unknown device"


async def test_offer_from_computer_to_phone(client):
    me = await make_actor(client, "qr-offer")
    other = await make_actor(client, "qr-other")
    o = await client.post("/auth/link/offer", headers={**me.h, **LAPTOP})
    assert o.status_code == 201, o.text
    offer = o.json()
    assert offer["url"].endswith("/link#" + offer["token"])
    assert (await me.get(f"/auth/link/{offer['id']}")).json()["status"] == "waiting"
    assert (await other.get(f"/auth/link/{offer['id']}")).status_code == 404          # only its owner sees it

    peek = await client.post("/auth/link/peek", json={"token": offer["token"]})
    assert peek.json()["kind"] == "offer" and peek.json()["device"] == "Chrome on Windows"
    c = await client.post("/auth/link/claim", json={"token": offer["token"]}, headers=PHONE)
    assert c.status_code == 200 and c.json()["device"] == "Chrome on Android"
    secret, match = c.json()["secret"], c.json()["match"]
    # a second scan (someone else photographing the screen) gets nothing
    assert (await client.post("/auth/link/claim", json={"token": offer["token"]})).status_code == 410

    # waiting for the yes on the computer
    r = await client.post("/auth/link/redeem", json={"token": offer["token"], "secret": secret})
    assert r.status_code == 202
    assert (await client.post("/auth/link/redeem", json={"token": offer["token"], "secret": "x" * 43})).status_code == 410
    st = (await me.get(f"/auth/link/{offer['id']}")).json()
    assert st["status"] == "claimed" and st["device"] == "Chrome on Android"
    assert match in st["options"] and len(st["options"]) == 3          # pick the number the phone shows
    assert (await other.post(f"/auth/link/{offer['id']}/decide", json={"approve": True, "match": match})).status_code == 404
    assert (await me.post(f"/auth/link/{offer['id']}/decide", json={"approve": True})).status_code == 422
    d = await me.post(f"/auth/link/{offer['id']}/decide", json={"approve": True, "match": match})
    assert d.status_code == 200 and d.json()["status"] == "approved"

    r = await client.post("/auth/link/redeem", json={"token": offer["token"], "secret": secret}, headers=PHONE)
    assert r.status_code == 200, r.text
    tok = r.json()["access_token"]
    who = await client.get("/auth/me", headers={"Authorization": f"Bearer {tok}"})
    assert who.json()["email"] == me.email
    # once only
    assert (await client.post("/auth/link/redeem", json={"token": offer["token"], "secret": secret})).status_code == 410

    # the phone now shows in the devices list, and can be signed out
    phone_h = {"Authorization": f"Bearer {tok}", **PHONE}
    rows = (await client.get("/auth/sessions", headers=phone_h)).json()
    assert len(rows) == 2
    phone = next(x for x in rows if x["this_device"])
    assert phone["device"] == "Chrome on Android"
    assert (await other.delete(f"/auth/sessions/{phone['id']}")).status_code == 404
    assert (await me.delete(f"/auth/sessions/{phone['id']}")).status_code == 204
    assert len((await me.get("/auth/sessions")).json()) == 1
    refresh = r.json()["refresh_token"]
    assert (await client.post("/auth/refresh", json={"refresh_token": refresh})).status_code == 401


async def test_offer_refused(client):
    me = await make_actor(client, "qr-refuse")
    offer = (await me.post("/auth/link/offer")).json()
    secret = (await client.post("/auth/link/claim", json={"token": offer["token"]})).json()["secret"]
    assert (await me.post(f"/auth/link/{offer['id']}/decide", json={"approve": False})).json()["status"] == "rejected"
    assert (await client.post("/auth/link/redeem", json={"token": offer["token"], "secret": secret})).status_code == 403
    assert (await me.post(f"/auth/link/{offer['id']}/decide", json={"approve": True, "match": "42"})).status_code == 409


async def test_request_from_login_page_answered_on_phone(client):
    me = await make_actor(client, "qr-request")
    q = await client.post("/auth/link/request", headers=LAPTOP)
    assert q.status_code == 201, q.text
    req = q.json()
    peek = (await client.post("/auth/link/peek", json={"token": req["token"]})).json()
    assert peek["kind"] == "request" and peek["device"] == "Chrome on Windows"
    # an offer-only step can't be used on a request
    assert (await client.post("/auth/link/claim", json={"token": req["token"]})).status_code == 410
    assert (await client.post("/auth/link/redeem", json={"token": req["token"], "secret": req["secret"]})).status_code == 202
    assert req["match"] in peek["options"]
    ok = {"token": req["token"], "approve": True, "match": req["match"]}
    assert (await client.post("/auth/link/answer", json=ok)).status_code == 401
    a = await client.post("/auth/link/answer", json=ok, headers={**me.h, **PHONE})
    assert a.status_code == 200 and a.json()["status"] == "approved"
    assert (await me.post("/auth/link/answer", json=ok)).status_code == 410
    r = await client.post("/auth/link/redeem", json={"token": req["token"], "secret": req["secret"]})
    assert r.status_code == 200
    who = await client.get("/auth/me", headers={"Authorization": f"Bearer {r.json()['access_token']}"})
    assert who.json()["email"] == me.email


async def test_unknown_token(client):
    assert (await client.post("/auth/link/peek", json={"token": "A" * 43})).status_code == 410
    assert (await client.post("/auth/link/peek", json={"token": "short"})).status_code == 422
    assert (await client.post("/auth/link/offer")).status_code == 401
