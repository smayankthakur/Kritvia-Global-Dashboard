"""Pre-launch test report, security findings S1-S6: outbound address checks (NAT64, DNS rebinding), a custom
app's own read-only marks, who sees a draft's contents, the production client-IP setting, and signing a
device out at once."""
from __future__ import annotations

import ipaddress

import httpcore
import httpx
import pytest

from conftest import join, make_actor
from kritvia_api.services import mcp, netguard
from test_assistant import ask, desk, fake_mcp, script  # noqa: F401

pytestmark = pytest.mark.asyncio


# ------------------------------------------------------------------------- S1: address rules --
@pytest.mark.parametrize("addr", [
    "64:ff9b::a9fe:a9fe",          # NAT64 form of 169.254.169.254 (cloud metadata)
    "64:ff9b::7f00:1",             # NAT64 form of 127.0.0.1
    "64:ff9b::a00:5",              # NAT64 form of 10.0.0.5
    "::ffff:169.254.169.254", "::ffff:127.0.0.1",
    "169.254.169.254", "127.0.0.1", "10.0.0.5", "192.168.1.10", "100.64.0.1", "0.0.0.0",
    "::1", "::", "fd00::1", "fe80::1", "224.0.0.1", "240.0.0.1",
])
async def test_private_addresses_in_any_form_are_refused(addr):
    assert not netguard.public_ip(ipaddress.ip_address(addr))
    assert not netguard.all_public([addr])


async def test_public_addresses_pass():
    assert netguard.all_public(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946", "64:ff9b::5db8:d822"])
    assert not netguard.all_public([])                                  # nothing resolved is not "public"
    assert not netguard.all_public(["93.184.216.34", "10.0.0.1"])        # every address must be public


async def test_check_url_refuses_a_nat64_answer(monkeypatch):
    async def nat64(host):
        return ["64:ff9b::a9fe:a9fe"]
    monkeypatch.setattr(mcp, "resolve", nat64)
    with pytest.raises(mcp.McpError, match="private network"):
        await mcp.check_url("https://looks-public.example.com/mcp")

    async def public(host):
        return ["93.184.216.34"]
    monkeypatch.setattr(mcp, "resolve", public)
    assert await mcp.check_url("https://looks-public.example.com/mcp") == "https://looks-public.example.com/mcp"


# ------------------------------------------------------------------- S2: checked at connection --
class Recorder(httpcore.AsyncNetworkBackend):
    """Stands in for the real sockets: records where a connection would go, then stops."""

    def __init__(self) -> None:
        self.opened: list[tuple[str, int]] = []

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        self.opened.append((host, port))
        raise httpcore.ConnectError("test: stop here")

    async def connect_unix_socket(self, path, timeout=None, socket_options=None):
        raise httpcore.ConnectError("no")

    async def sleep(self, seconds):
        return None


def _client(answers: dict[str, list[str]]) -> tuple[httpx.AsyncClient, Recorder]:
    async def resolver(host):
        return answers[host]
    t = netguard.guarded_transport(resolver)
    rec = Recorder()
    t._pool._network_backend.inner = rec
    return httpx.AsyncClient(transport=t, follow_redirects=False), rec


async def test_connection_goes_to_the_address_it_just_checked():
    client, rec = _client({"app.example.com": ["93.184.216.34"]})
    async with client:
        with pytest.raises(httpx.ConnectError):
            await client.get("https://app.example.com/mcp")
    assert rec.opened == [("93.184.216.34", 443)]


async def test_a_dns_answer_that_changes_after_the_check_cannot_reach_inside(monkeypatch):
    answers = {"rebind.example.com": ["93.184.216.34"]}

    async def resolve(host):
        return answers[host]
    monkeypatch.setattr(mcp, "resolve", resolve)
    assert await mcp.check_url("https://rebind.example.com/mcp")       # the early check sees a public address
    answers["rebind.example.com"] = ["169.254.169.254"]                  # ...then the answer changes
    client, rec = _client(answers)
    async with client:
        with pytest.raises(httpx.ConnectError, match="private network"):
            await client.get("https://rebind.example.com/mcp")
    assert rec.opened == []                                              # no connection was opened at all


async def test_private_ip_literals_and_nat64_are_refused_at_connection():
    client, rec = _client({})
    async with client:
        for url in ("https://127.0.0.1/", "https://[64:ff9b::a9fe:a9fe]/", "https://[::ffff:10.0.0.1]:8443/"):
            with pytest.raises(httpx.ConnectError):
                await client.get(url)
    assert rec.opened == []


async def test_customer_addresses_use_the_guarded_connection():
    c = mcp.Client("https://app.example.com/mcp")._http()
    assert isinstance(c._transport._pool._network_backend, netguard.GuardedBackend)
    await c.aclose()
    from kritvia_api.services import mcp_oauth, openapi_app, sso
    for client in (openapi_app._http(), mcp_oauth._http(), sso._client()):
        assert isinstance(client._transport._pool._network_backend, netguard.GuardedBackend)
        assert client.follow_redirects is False
        await client.aclose()


# ------------------------------------------------------------- S3: a custom app's own marks --
async def test_only_checked_apps_may_skip_the_approval():
    assert mcp.trusts_read_only("openapi", "https://shop.example.com/openapi.json")
    assert mcp.trusts_read_only("hosted", "runner:1")
    assert mcp.trusts_read_only("mcp", "https://mcp.hubspot.com")
    assert mcp.trusts_read_only("mcp", "https://MCP.HubSpot.com/")
    assert not mcp.trusts_read_only("mcp", "https://mcp.example-crm.com/mcp")
    assert not mcp.trusts_read_only("mcp", "https://mcp.hubspot.com.evil.example")
    assert not mcp.trusts_read_only("mcp", "http://mcp.hubspot.com")


async def test_a_custom_servers_read_only_tool_still_asks_first(desk, fake_llm, fake_mcp):  # noqa: F811
    mayank, v = desk["mayank"], desk["v"]
    # the catalog id is the caller's word, so it doesn't make a custom address trusted
    r = await mayank.post(f"/ventures/{v}/apps", json={"name": "crm", "url": "https://mcp.example-crm.com/mcp",
                                                       "token": "secret-token", "catalog_id": "kritvia:hubspot"})
    assert r.status_code == 201, r.text
    assert [(t["name"], t["read_only"]) for t in r.json()["tools"]] == [("find_contact", False),
                                                                       ("create_contact", False)]
    script(fake_llm, {"tool": "app.crm.find_contact", "args": {"name": "Ravi"}}, {"answer": "?"})
    item = await ask(mayank, v, "find Ravi in the crm")
    assert item["steps"][0]["result"] == "waiting for approval"
    assert not [c for c in fake_mcp.calls if (c["params"] or {}).get("name") == "find_contact"]


# ----------------------------------------------------------------- S4: who sees a draft's text --
async def test_a_viewer_sees_the_title_but_not_the_draft(desk, fake_llm, fake_mcp, client):  # noqa: F811
    mayank, v = desk["mayank"], desk["v"]
    await mayank.post(f"/ventures/{v}/apps", json={"name": "crm", "url": "https://mcp.example-crm.com/mcp",
                                                   "token": "secret-token"})
    script(fake_llm, {"tool": "app.crm.create_contact", "args": {"name": "Ravi", "phone": "+919800000001"},
                      "title": "Add Ravi to the CRM"}, {"answer": "?"})
    item = await ask(mayank, v, "add Ravi to the crm")
    aid = item["pending_approval_id"]
    viewer = await make_actor(client, "draft-viewer")
    await join(mayank, viewer, desk["org"], v, "viewer")

    seen = (await viewer.get(f"/ventures/{v}/approvals/{aid}")).json()
    assert seen["title"] == "Add Ravi to the CRM" and seen["can_decide"] is False
    assert seen["redacted"] is True and seen["payload"] is None and seen["final_payload"] is None
    assert seen["diff"] == []
    assert "+919800000001" not in (await viewer.get(f"/ventures/{v}/approvals")).text
    listed = (await viewer.get(f"/ventures/{v}/approvals")).json()
    assert listed and all(a["redacted"] and a["payload"] is None for a in listed)
    inbox = [a for a in (await viewer.get("/approvals/inbox")).json() if a["id"] == aid]
    assert inbox and inbox[0]["payload"] is None and "+919800000001" not in str(inbox)

    own = (await mayank.get(f"/ventures/{v}/approvals/{aid}")).json()
    assert own["can_decide"] is True and own["redacted"] is False
    assert own["payload"]["phone"] == "+919800000001"


# ---------------------------------------------------------------- S5: client IP in production --
async def test_production_needs_the_client_ip_header(monkeypatch):
    from kritvia_api.config import get_settings
    from kritvia_api.main import check_production_config
    s = get_settings()
    monkeypatch.setattr(s, "environment", "production")
    monkeypatch.setattr(s, "client_ip_header", "")
    with pytest.raises(RuntimeError) as e:
        check_production_config()
    assert "CLIENT_IP_HEADER" in str(e.value) and "cf-connecting-ip" in str(e.value)
    monkeypatch.setattr(s, "client_ip_header", "cf-connecting-ip")
    try:
        check_production_config()
    except RuntimeError as exc:                     # other test-only settings may still be refused
        assert "CLIENT_IP_HEADER" not in str(exc)


# --------------------------------------------------------------- S6: sign a device out at once --
async def test_signing_a_device_out_stops_its_access_token_at_once(client):
    me = await make_actor(client, "signout-now")
    login = await client.post("/auth/login", json={"email": me.email, "password": "correct horse battery"},
                              headers={"user-agent": "Mozilla/5.0 (Linux; Android 14) Chrome/128.0 Mobile"})
    assert login.status_code == 200, login.text
    phone = {"Authorization": f"Bearer {login.json()['access_token']}"}
    assert (await client.get("/auth/me", headers=phone)).status_code == 200
    rows = (await me.get("/auth/sessions")).json()
    assert len(rows) == 2
    # end every sign-in but the computer's own (the session the first token belongs to)
    from kritvia_api.security import token_family
    mine = str(token_family(me.token))
    other = next(r for r in rows if r["id"] != mine)
    assert (await me.delete(f"/auth/sessions/{other['id']}")).status_code == 204
    r = await client.get("/auth/me", headers=phone)
    assert r.status_code == 401 and "no longer valid" in r.json()["detail"]
    assert (await client.get("/auth/me", headers=me.h)).status_code == 200      # this device still works


async def test_renewed_tokens_keep_their_sign_in_and_reuse_ends_it(client):
    me = await make_actor(client, "renew-fam")
    login = (await client.post("/auth/login", json={"email": me.email, "password": "correct horse battery"})).json()
    from kritvia_api.security import token_family
    fam = token_family(login["access_token"])
    assert fam is not None
    renewed = (await client.post("/auth/refresh", json={"refresh_token": login["refresh_token"]})).json()
    assert token_family(renewed["access_token"]) == fam
    h = {"Authorization": f"Bearer {renewed['access_token']}"}
    assert (await client.get("/auth/me", headers=h)).status_code == 200
    # presenting the old refresh token again (a stolen copy) ends the whole sign-in, access tokens included
    assert (await client.post("/auth/refresh", json={"refresh_token": login["refresh_token"]})).status_code == 401
    assert (await client.get("/auth/me", headers=h)).status_code == 401


async def test_tokens_without_a_sign_in_still_work(client):
    me = await make_actor(client, "no-fam")
    from kritvia_api.security import issue_access_token
    h = {"Authorization": f"Bearer {issue_access_token(me.id)}"}
    assert (await client.get("/auth/me", headers=h)).status_code == 200
