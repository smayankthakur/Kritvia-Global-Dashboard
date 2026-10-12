"""'Connect WhatsApp' with Meta's Embedded Signup: the owner logs in with Facebook in Meta's window,
Kritvia exchanges the code, checks the number, switches on incoming messages, activates the number
and saves it. Nothing is copied by hand."""
from __future__ import annotations

import json
import uuid

import httpx
import pytest

from conftest import join, make_actor

pytestmark = pytest.mark.asyncio

APP_ID, CONFIG_ID, SECRET = "4242424242", "cfg-777", "app-secret-123"


class FakeGraph:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict]] = []
        self.bad_code = False

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path, auth = request.url.path, request.headers.get("authorization", "")
        body = json.loads(request.content) if request.content else {}
        self.calls.append((request.method, path, {**dict(request.url.params), **body, "auth": auth}))
        if path.endswith("/oauth/access_token"):
            if self.bad_code or request.url.params.get("client_secret") != SECRET:
                return httpx.Response(400, json={"error": {"message": "Invalid verification code"}})
            return httpx.Response(200, json={"access_token": "EAAG-business-token", "token_type": "bearer"})
        if request.method == "GET" and path.endswith("/phone_numbers"):
            return httpx.Response(200, json={"data": [{"id": "123450009"}]})
        if request.method == "GET":          # number profile
            if auth != "Bearer EAAG-business-token" or "999" in path:
                return httpx.Response(400, json={"error": {"message": "no access"}})
            return httpx.Response(200, json={"display_phone_number": "+91 99999 11111", "verified_name": "Glow Salon"})
        if path.endswith("/subscribed_apps") or path.endswith("/register"):
            return httpx.Response(200, json={"success": True})
        return httpx.Response(404, json={})


@pytest.fixture
def graph(services, monkeypatch):
    from kritvia_api.config import get_settings
    from kritvia_api.services.whatsapp import WhatsAppClient
    fake = FakeGraph()
    wa = WhatsAppClient(SECRET, "verify-me", transport=httpx.MockTransport(fake))
    old = services.whatsapp, services.messaging.whatsapp
    services.whatsapp = services.messaging.whatsapp = wa
    monkeypatch.setattr(get_settings(), "meta_app_id", APP_ID)
    monkeypatch.setattr(get_settings(), "whatsapp_signup_config_id", CONFIG_ID)
    yield fake
    services.whatsapp, services.messaging.whatsapp = old


@pytest.fixture(scope="module")
async def salon(world, client):
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Glow Salon", "slug": f"glow-{uuid.uuid4().hex[:6]}"})).json()["id"]
    operator = await make_actor(client, "salon-operator")
    await join(mayank, operator, world["org"], v, "operator")
    return {**world, "v": v, "operator": operator}


def signup(pnid: str | None = "123450001", waba="987650001", code="AQB-code-from-meta-xyz", business_app=False) -> dict:
    return {"code": code, "phone_number_id": pnid, "waba_id": waba, "business_app": business_app}


async def test_button_is_off_until_the_server_is_set_up(salon, services):
    mayank, v = salon["mayank"], salon["v"]
    cfg = (await mayank.get(f"/ventures/{v}/connectors/whatsapp/signup")).json()
    assert cfg["ready"] is False and cfg["app_id"] == "" and cfg["config_id"] == ""
    r = await mayank.post(f"/ventures/{v}/connectors/whatsapp/signup", json=signup())
    assert r.status_code == 409


async def test_connect_with_meta_signup(salon, graph):
    mayank, v = salon["mayank"], salon["v"]
    cfg = (await mayank.get(f"/ventures/{v}/connectors/whatsapp/signup")).json()
    assert cfg == {"ready": True, "app_id": APP_ID, "config_id": CONFIG_ID, "graph_version": "v25.0"}

    r = await mayank.post(f"/ventures/{v}/connectors/whatsapp/signup", json=signup())
    assert r.status_code == 201, r.text
    assert r.json()["display_phone_number"] == "+91 99999 11111" and r.json()["verified_name"] == "Glow Salon"
    assert "EAAG" not in r.text
    steps = [(m, p.rsplit("/", 1)[-1]) for m, p, _ in graph.calls]
    assert steps == [("GET", "access_token"), ("GET", "123450001"), ("POST", "subscribed_apps"), ("POST", "register")]
    exchange = graph.calls[0][2]
    assert exchange["client_id"] == APP_ID and exchange["code"] == "AQB-code-from-meta-xyz"
    sub, reg = graph.calls[2], graph.calls[3]
    assert "/987650001/" in sub[1] and sub[2]["auth"] == "Bearer EAAG-business-token"
    assert reg[2]["messaging_product"] == "whatsapp" and len(reg[2]["pin"]) == 6 and reg[2]["pin"].isdigit()
    conns = (await mayank.get(f"/ventures/{v}/connectors")).json()
    wa = next(c for c in conns if c["provider"] == "whatsapp")
    assert wa["status"] == "active" and "EAAG" not in json.dumps(conns)


async def test_number_kept_on_the_business_app_is_not_re_registered(salon, graph):
    mayank, v = salon["mayank"], salon["v"]
    r = await mayank.post(f"/ventures/{v}/connectors/whatsapp/signup", json=signup(pnid="123450002", business_app=True))
    assert r.status_code == 201, r.text
    assert not any(p.endswith("/register") for _, p, _ in graph.calls)


async def test_bad_or_foreign_signups_save_nothing(salon, graph):
    mayank, operator, v = salon["mayank"], salon["operator"], salon["v"]
    graph.bad_code = True
    r = await mayank.post(f"/ventures/{v}/connectors/whatsapp/signup", json=signup(pnid="123450003"))
    assert r.status_code == 422 and "try connecting again" in r.json()["detail"]
    graph.bad_code = False
    # a number id the token can't reach (e.g. typed in by hand) is refused
    r = await mayank.post(f"/ventures/{v}/connectors/whatsapp/signup", json=signup(pnid="999000111"))
    assert r.status_code == 422
    conns = (await mayank.get(f"/ventures/{v}/connectors")).json()
    assert all(c.get("external_id") not in ("123450003", "999000111") for c in conns)
    # only the business's admins connect it
    r = await operator.post(f"/ventures/{v}/connectors/whatsapp/signup", json=signup(pnid="123450004"))
    assert r.status_code in (403, 404)
    # and a business you can't see is not found
    r = await salon["mallory"].post(f"/ventures/{v}/connectors/whatsapp/signup", json=signup(pnid="123450005"))
    assert r.status_code == 404


async def test_number_is_looked_up_when_the_window_does_not_name_it(salon, graph):
    mayank, v = salon["mayank"], salon["v"]
    r = await mayank.post(f"/ventures/{v}/connectors/whatsapp/signup", json=signup(pnid=None, business_app=True))
    assert r.status_code == 201, r.text
    assert any(p.endswith("/987650001/phone_numbers") for _, p, _ in graph.calls)
    assert any(p.endswith("/123450009") for _, p, _ in graph.calls)
