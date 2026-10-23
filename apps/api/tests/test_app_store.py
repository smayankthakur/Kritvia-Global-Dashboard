"""The App store (patch 0095): apps by address with every kind of token, sign-in with OAuth (discovery, PKCE,
resource, refresh), any web app by its OpenAPI description, apps hosted in the sandboxed runner after Kritvia's
team approves them, GitHub projects (skills, packages), the MCP Registry sync, and apps sending events in."""
from __future__ import annotations

import base64
import hashlib
import json
import uuid
from urllib.parse import parse_qs, urlparse

import asyncpg
import httpx
import pytest

from conftest import ADMIN_DSN
from kritvia_api.services import app_catalog, github_install, mcp, mcp_oauth, openapi_app
from test_assistant import FakeMcp, ask, desk, script  # noqa: F401

pytestmark = pytest.mark.asyncio
NONCE = "n" * 40


async def sql(q: str, *args):
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        return await conn.fetch(q, *args)
    finally:
        await conn.close()


class Net:
    """A small internet: hosts -> handlers. Every request is recorded."""

    def __init__(self) -> None:
        self.hosts: dict[str, object] = {}
        self.seen: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(request)
        h = self.hosts.get(request.url.host)
        if h is None:
            return httpx.Response(404)
        return h(request)


@pytest.fixture
def net(monkeypatch):
    n = Net()
    t = httpx.MockTransport(n)
    for mod in (mcp, mcp_oauth, openapi_app, github_install, app_catalog):
        monkeypatch.setattr(mod, "transport", t)

    async def public(host):
        return ["93.184.216.34"]
    monkeypatch.setattr(mcp, "resolve", public)
    return n


async def ask_approved(actor, v, question: str) -> dict:
    """Ask, then approve the card a custom app's tool raises (its own read-only mark isn't trusted), and
    return the finished item."""
    item = await ask(actor, v, question)
    if item.get("pending_approval_id"):
        a = (await actor.get(f"/ventures/{v}/approvals/{item['pending_approval_id']}")).json()
        assert a["action"] == "mcp.call"
        await actor.post(f"/ventures/{v}/approvals/{a['id']}/decision", json={"decision": "approve"})
        item = (await actor.get(f"/ventures/{v}/assistant/{item['run_id']}")).json()
    return item


class HeaderMcp(FakeMcp):
    """FakeMcp that checks any header instead of only Bearer."""

    def __init__(self, check) -> None:
        super().__init__(sse=False)
        self.check = check

    def __call__(self, request):
        if not self.check(request.headers):
            return httpx.Response(401)
        h = dict(request.headers)
        h["authorization"] = f"Bearer {self.token}"
        return super().__call__(httpx.Request(request.method, request.url, headers=h, content=request.content))


# ------------------------------------------------------------------------------- by address --
async def test_tokens_go_where_the_app_wants_them(desk, net):
    mayank, v = desk["mayank"], desk["v"]
    net.hosts["mcp.exa.example"] = HeaderMcp(lambda h: h.get("x-api-key") == "exa-key")
    net.hosts["mcp.basic.example"] = HeaderMcp(
        lambda h: h.get("authorization") == "Basic " + base64.b64encode(b"rzp_key:rzp_secret").decode())
    net.hosts["mcp.open.example"] = HeaderMcp(lambda h: "authorization" not in h)
    r = await mayank.post(f"/ventures/{v}/apps", json={"name": "exa", "url": "https://mcp.exa.example/mcp",
                                                       "auth": "header", "header_name": "x-api-key", "token": "exa-key"})
    assert r.status_code == 201 and r.json()["auth"] == "header", r.text
    r = await mayank.post(f"/ventures/{v}/apps", json={"name": "pay", "url": "https://mcp.basic.example/mcp",
                                                       "auth": "basic", "token": "rzp_key:rzp_secret"})
    assert r.status_code == 201, r.text
    r = await mayank.post(f"/ventures/{v}/apps", json={"name": "open", "url": "https://mcp.open.example/mcp"})
    assert r.status_code == 201 and r.json()["auth"] == "none" and r.json()["has_token"] is False
    bad = await mayank.post(f"/ventures/{v}/apps", json={"name": "pay2", "url": "https://mcp.basic.example/mcp",
                                                         "auth": "basic", "token": "no-colon"})
    assert bad.status_code == 422 and "user:password" in bad.json()["detail"]


async def test_the_header_app_is_called_with_its_header(desk, net, fake_llm):
    mayank, v = desk["mayank"], desk["v"]
    net.hosts["mcp.exa.ai"] = HeaderMcp(lambda h: h.get("x-api-key") == "exa-key")
    await mayank.post(f"/ventures/{v}/apps", json={"name": "exa", "url": "https://mcp.exa.ai/mcp",
                                                   "auth": "header", "header_name": "x-api-key", "token": "exa-key"})
    script(fake_llm, {"tool": "app.exa.find_contact", "args": {"name": "Ravi"}},
           lambda m: {"answer": "none found" if "No contact named Ravi" in m[-1]["content"] else "?"})
    item = await ask(mayank, v, "find Ravi in exa")
    assert item["answer"] == "none found" and item["steps"][0]["result"] == "done"


# ----------------------------------------------------------------------------------- OAuth --
class OAuthWorld:
    """An MCP server behind OAuth: protected resource metadata, an authorization server with dynamic client
    registration and PKCE, and a token endpoint that hands out access and refresh tokens."""

    def __init__(self, *, pkce: bool = True, issuer: str = "https://auth.notes.example", cimd: bool = False) -> None:
        self.pkce, self.issuer, self.cimd = pkce, issuer, cimd
        self.codes: dict[str, dict] = {}
        self.tokens = {"at-1"}
        self.registered: list[dict] = []
        self.token_calls: list[dict] = []
        self.mcp = FakeMcp(sse=False, token="at-1")
        self.refresh_ok = True

    def resource(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.startswith("/.well-known/oauth-protected-resource"):
            return httpx.Response(200, json={"resource": "https://mcp.notes.example/mcp",
                                             "authorization_servers": ["https://auth.notes.example"],
                                             "scopes_supported": ["notes.read", "notes.write"]})
        tok = (request.headers.get("authorization") or "").removeprefix("Bearer ")
        if tok not in self.tokens:
            return httpx.Response(401, headers={"WWW-Authenticate": 'Bearer resource_metadata='
                                                '"https://mcp.notes.example/.well-known/oauth-protected-resource/mcp",'
                                                ' scope="notes.read notes.write"'})
        self.mcp.token = tok
        return self.mcp(request)

    def auth(self, request: httpx.Request) -> httpx.Response:
        p = request.url.path
        if p == "/.well-known/oauth-authorization-server":
            meta = {"issuer": self.issuer, "authorization_endpoint": "https://auth.notes.example/authorize",
                    "token_endpoint": "https://auth.notes.example/token",
                    "registration_endpoint": "https://auth.notes.example/register",
                    "client_id_metadata_document_supported": self.cimd}
            if self.pkce:
                meta["code_challenge_methods_supported"] = ["S256"]
            return httpx.Response(200, json=meta)
        if p == "/register":
            body = json.loads(request.content)
            self.registered.append(body)
            return httpx.Response(201, json={"client_id": "dcr-client-1", **body})
        if p == "/token":
            form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            self.token_calls.append(form)
            if form["grant_type"] == "authorization_code":
                c = self.codes.pop(form["code"], None)
                ok = c and base64.urlsafe_b64encode(hashlib.sha256(form["code_verifier"].encode()).digest()) \
                    .decode().rstrip("=") == c["code_challenge"] and form["resource"] == c["resource"]
                if not ok:
                    return httpx.Response(400, json={"error": "invalid_grant"})
                return httpx.Response(200, json={"access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3600})
            if form["grant_type"] == "refresh_token" and self.refresh_ok and form["refresh_token"] == "rt-1":
                self.tokens.add("at-2")
                return httpx.Response(200, json={"access_token": "at-2", "refresh_token": "rt-2", "expires_in": 3600})
            return httpx.Response(400, json={"error": "invalid_grant"})
        return httpx.Response(404)

    def consent(self, authorize_url: str) -> tuple[str, str]:
        """The person signs in: returns (code, state) as the callback would get them."""
        q = {k: v[0] for k, v in parse_qs(urlparse(authorize_url).query).items()}
        code = "code-" + uuid.uuid4().hex[:8]
        self.codes[code] = q
        return code, q["state"]


@pytest.fixture
def notes(net):
    w = OAuthWorld()
    net.hosts["mcp.notes.example"] = w.resource
    net.hosts["auth.notes.example"] = w.auth
    return w


async def test_sign_in_with_oauth_then_refresh(desk, net, notes, fake_llm):
    mayank, v = desk["mayank"], desk["v"]
    r = await mayank.post(f"/ventures/{v}/apps/oauth/start",
                          json={"name": "notes", "url": "https://mcp.notes.example/mcp", "nonce": NONCE})
    assert r.status_code == 200, r.text
    url = r.json()["authorize_url"]
    q = {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}
    assert url.startswith("https://auth.notes.example/authorize?")
    assert q["code_challenge_method"] == "S256" and len(q["code_challenge"]) == 43
    assert q["resource"] == "https://mcp.notes.example/mcp" and q["scope"] == "notes.read notes.write"
    assert q["client_id"] == "dcr-client-1" and q["redirect_uri"].endswith("/api/oauth/mcp/callback")
    assert notes.registered[0]["application_type"] == "web" and notes.registered[0]["token_endpoint_auth_method"] == "none"
    code, state = notes.consent(url)
    # another browser (no matching nonce) can't finish it
    bad = await mayank.post("/apps/oauth/complete", json={"state": state, "code": code, "nonce": "x" * 40})
    assert bad.status_code == 400
    # …and the attempt used it up: start again
    r = await mayank.post(f"/ventures/{v}/apps/oauth/start",
                          json={"name": "notes", "url": "https://mcp.notes.example/mcp", "nonce": NONCE})
    code, state = notes.consent(r.json()["authorize_url"])
    wrong_iss = await mayank.post("/apps/oauth/complete", json={"state": state, "code": code, "nonce": NONCE,
                                                                "iss": "https://evil.example"})
    assert wrong_iss.status_code == 422 and "wrong server" in wrong_iss.json()["detail"]
    r = await mayank.post(f"/ventures/{v}/apps/oauth/start",
                          json={"name": "notes", "url": "https://mcp.notes.example/mcp", "nonce": NONCE})
    code, state = notes.consent(r.json()["authorize_url"])
    done = await mayank.post("/apps/oauth/complete", json={"state": state, "code": code, "nonce": NONCE,
                                                           "iss": "https://auth.notes.example"})
    assert done.status_code == 200, done.text
    app = done.json()["app"]
    assert done.json()["venture_id"] == v and app["auth"] == "oauth" and app["status"] == "active"
    assert [t["name"] for t in app["tools"]] == ["find_contact", "create_contact"]
    assert (await mayank.post("/apps/oauth/complete", json={"state": state, "code": code, "nonce": NONCE})).status_code == 400
    row = (await sql("SELECT oauth_enc, token_enc FROM mcp_servers WHERE id = $1", uuid.UUID(app["id"])))[0]
    assert row["oauth_enc"] and b"at-1" not in row["oauth_enc"] and row["token_enc"] is None

    # the token is about to expire: the next use refreshes it first, and keeps the new one
    real = mcp_oauth.needs_refresh
    mcp_oauth.needs_refresh = lambda tok: tok.get("access_token") == "at-1"
    try:
        def lookup():
            script(fake_llm, {"tool": "app.notes.find_contact", "args": {"name": "Ravi"}},
                   lambda m: {"answer": "checked" if "No contact named Ravi" in m[-1]["content"] else "?"})
        lookup()
        assert (await ask_approved(mayank, v, "look up Ravi in notes"))["answer"] == "checked"
        assert notes.token_calls[-1]["grant_type"] == "refresh_token" and notes.mcp.token == "at-2"
        refreshes = len([c for c in notes.token_calls if c["grant_type"] == "refresh_token"])
        lookup()
        assert (await ask_approved(mayank, v, "look up Ravi again"))["answer"] == "checked"
        assert len([c for c in notes.token_calls if c["grant_type"] == "refresh_token"]) == refreshes   # kept at-2
        # a refresh that fails: the app waits for someone to sign in again
        mcp_oauth.needs_refresh = lambda tok: True
        notes.refresh_ok = False
        lookup()
        await ask_approved(mayank, v, "look up Ravi once more")
        st = (await sql("SELECT status FROM mcp_servers WHERE id = $1", uuid.UUID(app["id"])))[0]["status"]
        assert st == "needs_auth"
    finally:
        mcp_oauth.needs_refresh = real


async def test_sign_in_is_refused_without_pkce_or_with_a_wrong_issuer(desk, net):
    mayank, v = desk["mayank"], desk["v"]
    for w, why in ((OAuthWorld(pkce=False), "PKCE"), (OAuthWorld(issuer="https://other.example"), "identify")):
        net.hosts["mcp.notes.example"], net.hosts["auth.notes.example"] = w.resource, w.auth
        r = await mayank.post(f"/ventures/{v}/apps/oauth/start",
                              json={"name": "notes", "url": "https://mcp.notes.example/mcp", "nonce": NONCE})
        assert r.status_code == 422 and why in r.json()["detail"], r.text
    # a server that supports client ID metadata documents gets Kritvia's address as the client id, no registration
    w = OAuthWorld(cimd=True)
    net.hosts["mcp.notes.example"], net.hosts["auth.notes.example"] = w.resource, w.auth
    r = await mayank.post(f"/ventures/{v}/apps/oauth/start",
                          json={"name": "notes", "url": "https://mcp.notes.example/mcp", "nonce": NONCE})
    q = parse_qs(urlparse(r.json()["authorize_url"]).query)
    assert q["client_id"][0].endswith("/api/k/public/mcp-client.json") and w.registered == []
    doc = (await mayank.c.get("/public/mcp-client.json")).json()
    assert doc["client_id"] == q["client_id"][0] and doc["redirect_uris"][0].endswith("/api/oauth/mcp/callback")


# --------------------------------------------------------------------------------- OpenAPI --
SPEC = {
    "openapi": "3.0.0", "info": {"title": "Shop API"}, "servers": [{"url": "/v1"}],
    "paths": {
        "/orders/{order_id}": {"get": {"operationId": "getOrder", "summary": "One order",
                                       "parameters": [{"name": "order_id", "in": "path", "required": True,
                                                       "schema": {"type": "string"}}]}},
        "/orders": {"get": {"operationId": "listOrders", "summary": "Orders",
                            "parameters": [{"name": "status", "in": "query", "schema": {"type": "string"}}]},
                    "post": {"operationId": "createOrder", "summary": "Create an order",
                             "requestBody": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/NewOrder"}}}}}},
    },
    "components": {"schemas": {"NewOrder": {"type": "object", "required": ["item"],
                                            "properties": {"item": {"type": "string"}, "qty": {"type": "integer"}}}}},
}


async def test_any_web_app_by_its_openapi_description(desk, net, fake_llm):
    mayank, v = desk["mayank"], desk["v"]
    made: list[dict] = []

    def shop(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/openapi.yaml":
            import yaml
            return httpx.Response(200, text=yaml.safe_dump(SPEC), headers={"content-type": "application/yaml"})
        if request.headers.get("authorization") != "Bearer shop-key":
            return httpx.Response(401)
        if request.url.path == "/v1/orders/A-7" and request.method == "GET":
            return httpx.Response(200, json={"id": "A-7", "status": "shipped"})
        if request.url.path == "/v1/orders" and request.method == "POST":
            made.append(json.loads(request.content))
            return httpx.Response(201, json={"id": "A-8"})
        return httpx.Response(404)
    net.hosts["api.shop.example"] = shop
    r = await mayank.post(f"/ventures/{v}/apps", json={"name": "shop", "kind": "openapi", "token": "shop-key",
                                                       "url": "https://api.shop.example/openapi.yaml"})
    assert r.status_code == 201, r.text
    tools = {t["name"]: t["read_only"] for t in r.json()["tools"]}
    assert tools == {"getOrder": True, "listOrders": True, "createOrder": False}
    script(fake_llm,
           {"tool": "app.shop.getOrder", "args": {"order_id": "A-7"}},
           lambda m: ({"tool": "app.shop.createOrder", "args": {"item": "Kaju katli", "qty": 2}, "title": "Order"}
                      if "shipped" in m[-1]["content"] else {"answer": "Ordered." if "A-8" in m[-1]["content"] else "?"}))
    item = await ask(mayank, v, "check A-7 then order 2 kaju katli")
    assert [s["result"] for s in item["steps"]] == ["done", "waiting for approval"] and made == []
    await mayank.post(f"/ventures/{v}/approvals/{item['pending_approval_id']}/decision", json={"decision": "approve"})
    assert made == [{"item": "Kaju katli", "qty": 2}]
    spec = openapi_app.parse(SPEC, "https://api.shop.example/openapi.json")
    assert spec["base_url"] == "https://api.shop.example/v1"
    with pytest.raises(mcp.McpError):
        openapi_app.parse({**SPEC, "servers": [{"url": "http://api.shop.example"}]}, "http://api.shop.example/x")


# ------------------------------------------------------------------------- GitHub and hosted --
SKILL = """---
name: invoice-follow-up
description: Chase unpaid invoices politely.
---
1. Find invoices more than 7 days overdue.
2. Draft a short WhatsApp reminder for each.
"""


@pytest.fixture
def github(net):
    pj = {"name": "@acme/crm-mcp", "dependencies": {"@modelcontextprotocol/sdk": "^1.0.0"}}

    def api(request: httpx.Request) -> httpx.Response:
        p = request.url.path
        if p == "/repos/acme/crm-tools":
            return httpx.Response(200, json={"name": "crm-tools", "description": "CRM tools for agents",
                                             "default_branch": "main", "stargazers_count": 42, "license": {"spdx_id": "MIT"}})
        if p == "/repos/acme/crm-tools/git/trees/main":
            return httpx.Response(200, json={"tree": [{"path": "skills/invoice-follow-up/SKILL.md", "type": "blob"},
                                                      {"path": "package.json", "type": "blob"},
                                                      {"path": "src/index.ts", "type": "blob"}]})
        return httpx.Response(404)

    def raw(request: httpx.Request) -> httpx.Response:
        files = {"/acme/crm-tools/main/skills/invoice-follow-up/SKILL.md": SKILL,
                 "/acme/crm-tools/main/package.json": json.dumps(pj)}
        body = files.get(request.url.path)
        return httpx.Response(200, text=body) if body else httpx.Response(404)

    net.hosts["api.github.com"] = api
    net.hosts["raw.githubusercontent.com"] = raw
    net.hosts["registry.npmjs.org"] = lambda r: httpx.Response(200, json={"dist-tags": {"latest": "1.4.0"}})
    return net


class Runner:
    """The MCP runner as the API sees it: instances to start, and the bridge."""

    def __init__(self) -> None:
        self.configs: dict[str, dict] = {}
        self.mcp = FakeMcp(sse=False, token="runner-token")

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.headers.get("authorization") != "Bearer runner-token":
            return httpx.Response(401)
        parts = request.url.path.strip("/").split("/")
        if parts[0] == "instances":
            if request.method == "PUT":
                self.configs[parts[1]] = json.loads(request.content)
                return httpx.Response(200, json={"status": "started"})
            self.configs.pop(parts[1], None)
            return httpx.Response(204)
        if parts[0] == "mcp":
            if parts[1] not in self.configs:
                return httpx.Response(409, json={"detail": "not running"})
            return self.mcp(request)
        return httpx.Response(404)


async def test_github_skills_and_a_reviewed_hosted_app(desk, github, fake_llm, monkeypatch):
    from kritvia_api.config import get_settings
    from kritvia_api.services.mailer import get_mailer
    mayank, v = desk["mayank"], desk["v"]
    monkeypatch.setattr(get_settings(), "staff_emails", "apps-team@kritvia.test")
    monkeypatch.setattr(get_settings(), "mcp_runner_url", "http://mcp-runner.internal:8300")
    monkeypatch.setattr(get_settings(), "mcp_runner_token", "runner-token")
    runner = Runner()
    github.hosts["mcp-runner.internal"] = runner
    repo = "https://github.com/acme/crm-tools"
    a = (await mayank.post(f"/ventures/{v}/apps/github", json={"url": repo})).json()
    assert a["kind"] == "hosted" and a["package"] == "npm @acme/crm-mcp@1.4.0" and a["catalog"] is None
    assert a["skills"][0]["name"] == "Invoice follow up" and "7 days overdue" in a["skills"][0]["instructions"]
    # a skill becomes a Kritvia skill, read as words
    r = await mayank.post(f"/ventures/{v}/apps/github/skills",
                          json={"url": repo, "paths": ["skills/invoice-follow-up/SKILL.md"]})
    assert r.status_code == 201, r.text
    skills = (await mayank.get(f"/ventures/{v}/skills")).json()
    assert any(s["name"] == "Invoice follow up" for s in skills)
    # the package can't be installed until Kritvia's team approved it
    cid = "github:acme/crm-tools"
    r = await mayank.post(f"/ventures/{v}/apps/hosted", json={"name": "crm", "catalog_id": cid})
    assert r.status_code == 422 and "approved" in r.json()["detail"]
    out = get_mailer().outbox
    before = len(out)
    sent = await mayank.post(f"/ventures/{v}/apps/github/submit", json={"url": repo, "note": "we use it daily"})
    assert sent.status_code == 201 and sent.json()["status"] == "pending" and not sent.json()["installable"]
    assert [m["To"] for m in out[before:]] == ["apps-team@kritvia.test"]
    # Kritvia's team reviews it, with the sites it may reach
    assert (await mayank.get("/staff/apps")).status_code == 404            # not on Kritvia's team
    monkeypatch.setattr(get_settings(), "staff_emails", mayank.email)
    staff = (await mayank.get("/staff/apps")).json()
    mine = next(s for s in staff if s["id"] == cid)
    assert mine["status"] == "pending" and mine["submitted_by"] == mayank.email
    bad = await mayank.post("/staff/apps/review", json={"id": cid, "status": "approved", "egress_hosts": ["10.0.0.1"]})
    assert bad.status_code == 422
    ok = await mayank.post("/staff/apps/review", json={"id": cid, "status": "approved",
                                                       "egress_hosts": ["api.acme-crm.com"], "note": "read the code"})
    assert next(s for s in ok.json() if s["id"] == cid)["status"] == "approved"
    # a later registry or GitHub refresh never changes the approved version
    await sql("SELECT private.catalog_upsert($1::jsonb)", json.dumps({
        "id": cid, "source": "github", "kind": "hosted", "title": "crm-tools", "status": "pending",
        "package": {"registryType": "npm", "identifier": "@acme/crm-mcp", "version": "9.9.9", "env": []}}))
    st = (await sql("SELECT status, package->>'version' AS v FROM app_catalog WHERE id = $1", cid))[0]
    assert (st["status"], st["v"]) == ("approved", "1.4.0")
    # now it installs: the runner gets the reviewed package, the approved sites and the settings
    r = await mayank.post(f"/ventures/{v}/apps/hosted", json={"name": "crm", "catalog_id": cid})
    assert r.status_code == 201, r.text
    app = r.json()
    assert app["kind"] == "hosted" and app["url"] == f"runner:{app['id']}"
    cfg = runner.configs[app["id"]]
    assert cfg["package"]["version"] == "1.4.0" and cfg["egress_hosts"] == ["api.acme-crm.com"]
    # the runner restarted (it lost the instance): the next call starts it again and carries on
    runner.configs.clear()
    script(fake_llm, {"tool": "app.crm.find_contact", "args": {"name": "Ravi"}},
           lambda m: {"answer": "nobody" if "No contact named Ravi" in m[-1]["content"] else "?"})
    assert (await ask(mayank, v, "is Ravi in the crm"))["answer"] == "nobody"
    assert app["id"] in runner.configs
    assert (await mayank.delete(f"/ventures/{v}/apps/{app['id']}")).status_code == 204
    assert app["id"] not in runner.configs


async def test_hosted_apps_are_off_without_a_runner(desk, net):
    mayank, v = desk["mayank"], desk["v"]
    await sql("SELECT private.catalog_upsert($1::jsonb)", json.dumps({
        "id": "github:acme/off", "source": "github", "kind": "hosted", "title": "off", "status": "pending",
        "package": {"registryType": "npm", "identifier": "off-mcp", "version": "1.0.0", "env": []}}))
    await sql("UPDATE app_catalog SET status = 'approved' WHERE id = 'github:acme/off'")
    r = await mayank.post(f"/ventures/{v}/apps/hosted", json={"name": "off", "catalog_id": "github:acme/off"})
    assert r.status_code == 422 and "MCP_RUNNER_URL" in r.json()["detail"]


# ------------------------------------------------------------------------------ the registry --
async def test_the_registry_sync_and_the_store(desk, net):
    mayank = desk["mayank"]
    pages = {
        None: {"servers": [
            {"server": {"name": "io.example/notes", "title": "Example Notes", "description": "Notes over MCP",
                        "remotes": [{"type": "streamable-http", "url": "https://mcp.notes.example/mcp"}]},
             "_meta": {"io.modelcontextprotocol.registry/official": {"status": "active"}}},
            {"server": {"name": "io.example/old", "remotes": [{"type": "streamable-http", "url": "https://old.example/mcp"}]},
             "_meta": {"io.modelcontextprotocol.registry/official": {"status": "deleted"}}},
        ], "metadata": {"nextCursor": "p2"}},
        "p2": {"servers": [
            {"server": {"name": "io.github.acme/time", "description": "What time is it",
                        "packages": [{"registryType": "pypi", "identifier": "mcp-server-time", "version": "0.6.2",
                                      "transport": {"type": "stdio"},
                                      "environmentVariables": [{"name": "TZ_KEY", "isSecret": True}]}]}},
            {"server": {"name": "io.example/templated", "remotes": [{"type": "streamable-http",
                                                                     "url": "https://{tenant}.example/mcp"}]}},
        ], "metadata": {}},
    }

    def registry(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v0.1/servers" and request.url.params["version"] == "latest"
        return httpx.Response(200, json=pages[request.url.params.get("cursor")])
    net.hosts["registry.modelcontextprotocol.io"] = registry
    await sql("SELECT private.catalog_upsert($1::jsonb)", json.dumps({
        "id": "registry:io.example/old", "source": "registry", "kind": "mcp", "title": "Old",
        "url": "https://old.example/mcp"}))
    got = await app_catalog.sync_registry()
    assert got == {"synced": 2, "dropped": 1}
    found = (await mayank.get("/app-store", params={"q": "notes"})).json()
    ids = [a["id"] for a in found]
    assert "kritvia:notion" in ids or "registry:io.example/notes" in ids
    notes = next(a for a in found if a["id"] == "registry:io.example/notes")
    assert notes["kind"] == "mcp" and notes["installable"] and notes["url"] == "https://mcp.notes.example/mcp"
    time_ = (await mayank.get("/app-store", params={"q": "time", "source": "registry"})).json()[0]
    assert time_["kind"] == "hosted" and not time_["installable"] and time_["package"] == "pypi mcp-server-time@0.6.2"
    assert time_["env"] == [{"name": "TZ_KEY", "secret": True, "required": False, "description": ""}]
    assert (await mayank.post("/app-store/request", json={"id": time_["id"]})).json() == {"status": "pending"}
    assert (await mayank.post("/app-store/request", json={"id": "registry:io.example/notes"})).status_code == 404
    popular = (await mayank.get("/app-store", params={"source": "kritvia"})).json()
    assert {"Notion", "HubSpot", "Stripe"} <= {a["title"] for a in popular}


# ---------------------------------------------------------------------------------- events in --
async def test_apps_send_events_in(desk, net, client):
    mayank, v = desk["mayank"], desk["v"]
    net.hosts["mcp.open.example"] = HeaderMcp(lambda h: True)
    app = (await mayank.post(f"/ventures/{v}/apps", json={"name": "shopify", "url": "https://mcp.open.example/mcp"})).json()
    hook = (await mayank.post(f"/ventures/{v}/apps/{app['id']}/hook")).json()
    assert hook["url"].endswith(f"/hooks/apps/{app['id']}") and hook["secret"].startswith("kvh_")
    assert (await mayank.get(f"/ventures/{v}/apps")).json()[0]["has_hook"] is True
    r = await client.post(f"/hooks/apps/{app['id']}", json={"summary": "Order #1001 paid"},
                          headers={"Authorization": f"Bearer {hook['secret']}"})
    assert r.status_code == 202, r.text
    ev = await sql("SELECT kind, summary FROM business_events WHERE subject_id = $1", uuid.UUID(app["id"]))
    assert [(e["kind"], e["summary"]) for e in ev] == [("app.event", "shopify: Order #1001 paid")]
    assert (await client.post(f"/hooks/apps/{app['id']}", json={}, headers={"Authorization": "Bearer nope"})).status_code == 401
    await mayank.delete(f"/ventures/{v}/apps/{app['id']}/hook")
    assert (await client.post(f"/hooks/apps/{app['id']}", json={},
                              headers={"Authorization": f"Bearer {hook['secret']}"})).status_code == 401
