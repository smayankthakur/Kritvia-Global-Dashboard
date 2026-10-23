"""The MCP runner with a local stdio server instead of docker: the sandbox command it would run, the bridge
(initialize answered from the first handshake, requests forwarded, ids mapped back), stop and restart, what it
refuses, and the egress guard (only the approved sites, only with the instance's own credentials).
Run: pytest services/mcp-runner/tests"""
from __future__ import annotations

import asyncio
import os
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest

os.environ["MCP_RUNNER_TOKEN"] = "runner-token"
os.environ["MCP_RUNNER_LOCAL"] = "1"
os.environ["MCP_ALLOW_HOSTS_FOR_TESTS"] = "127.0.0.1"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app as runner  # noqa: E402
import guard  # noqa: E402

FAKE = str(Path(__file__).with_name("fake_stdio_server.py"))
AUTH = {"Authorization": "Bearer runner-token"}
SEEN: list[tuple[list[str], dict[str, str]]] = []


@pytest.fixture(autouse=True)
def local_spawn(monkeypatch):
    async def spawn(argv, env):
        SEEN.append((argv, env))
        return await asyncio.create_subprocess_exec(
            sys.executable, "-u", FAKE, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, env={"PATH": os.environ["PATH"], **{k: v for k, v in env.items() if k == "FAKE_KEY"}})
    monkeypatch.setattr(runner, "spawn", spawn)


def client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=runner.app), base_url="http://runner")


CFG = {"package": {"registryType": "npm", "identifier": "@acme/mcp-server", "version": "1.2.3"},
       "egress_hosts": ["api.acme.com"], "env": {"FAKE_KEY": "sk-very-secret"}}


async def test_an_instance_starts_sandboxed_and_bridges_requests():
    iid = str(uuid.uuid4())
    async with client() as c:
        assert (await c.post(f"/mcp/{iid}", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                             headers=AUTH)).status_code == 409                       # not running yet
        r = await c.put(f"/instances/{iid}", json=CFG, headers=AUTH)
        assert r.json() == {"status": "started"}, r.text
        argv, env = SEEN[-1]
        assert "--runtime=runsc" in argv and "--read-only" in argv and "--cap-drop=ALL" in argv
        assert f"--network={runner.NETWORK}" in argv and "--user" in argv
        assert argv[-3:] == ["npx", "--yes", "@acme/mcp-server@1.2.3"]
        assert not any("sk-very-secret" in a for a in argv)                         # secrets stay out of argv
        assert env["FAKE_KEY"] == "sk-very-secret" and "--env" in argv and "FAKE_KEY" in argv
        assert env["HTTPS_PROXY"].startswith(f"http://{iid}:") and env["NODE_USE_ENV_PROXY"] == "1"
        assert runner.INSTANCES[iid].grant.hosts == ["api.acme.com", "registry.npmjs.org"]
        # Kritvia's client opens a session every time: answered without touching the app
        init = (await c.post(f"/mcp/{iid}", json={"jsonrpc": "2.0", "id": 7, "method": "initialize", "params": {}},
                             headers=AUTH)).json()
        assert init["id"] == 7 and init["result"]["serverInfo"]["name"] == "fake"
        assert (await c.post(f"/mcp/{iid}", json={"jsonrpc": "2.0", "method": "notifications/initialized"},
                             headers=AUTH)).status_code == 202
        tools = (await c.post(f"/mcp/{iid}", json={"jsonrpc": "2.0", "id": 8, "method": "tools/list"}, headers=AUTH)).json()
        assert tools["id"] == 8 and tools["result"]["tools"][0]["name"] == "echo"
        call = (await c.post(f"/mcp/{iid}", json={"jsonrpc": "2.0", "id": "x", "method": "tools/call",
                                                   "params": {"name": "echo", "arguments": {"text": "hi"}}},
                             headers=AUTH)).json()
        assert call["id"] == "x" and call["result"]["content"][0]["text"] == "hi (key sk-very-secret)"
        # the same configuration again keeps it running; a changed one restarts it
        assert (await c.put(f"/instances/{iid}", json=CFG, headers=AUTH)).json() == {"status": "running"}
        changed = {**CFG, "env": {"FAKE_KEY": "new"}}
        assert (await c.put(f"/instances/{iid}", json=changed, headers=AUTH)).json() == {"status": "started"}
        assert (await c.delete(f"/instances/{iid}", headers=AUTH)).status_code == 204
        assert (await c.post(f"/mcp/{iid}", json={"jsonrpc": "2.0", "id": 9, "method": "tools/list"},
                             headers=AUTH)).status_code == 409


async def test_what_the_runner_refuses():
    iid = str(uuid.uuid4())
    async with client() as c:
        assert (await c.put(f"/instances/{iid}", json=CFG)).status_code == 401
        assert (await c.put("/instances/not-a-uuid", json=CFG, headers=AUTH)).status_code == 422
        for pkg in ({"registryType": "npm", "identifier": "../../etc", "version": "1"},
                    {"registryType": "npm", "identifier": "ok-name", "version": "1; rm -rf /"},
                    {"registryType": "pypi", "identifier": "-e git+https://x", "version": "1"}):
            r = await c.put(f"/instances/{iid}", json={**CFG, "package": pkg}, headers=AUTH)
            assert r.status_code == 422, pkg
        for env in ({"HTTPS_PROXY": "http://evil"}, {"NODE_OPTIONS": "--require x"}, {"lower": "x"}, {"K": "a\nb"}):
            assert (await c.put(f"/instances/{iid}", json={**CFG, "env": env}, headers=AUTH)).status_code == 422, env
        assert (await c.put(f"/instances/{iid}", json={**CFG, "egress_hosts": ["10.0.0.1"]},
                            headers=AUTH)).status_code == 422


def test_pypi_and_images():
    cfg = runner.StartIn(package={"registryType": "pypi", "identifier": "mcp-server-time", "version": "0.6.2"})
    argv, env = runner.argv_for("i", cfg, "s")
    assert argv[-2:] == ["uvx", "mcp-server-time==0.6.2"] and env["UV_CACHE_DIR"].startswith("/home/app")
    img = runner.StartIn(package={"registryType": "oci", "identifier": "ghcr.io/acme/mcp", "version": "2.0"})
    assert runner.argv_for("i", img, "s")[0][-1] == "ghcr.io/acme/mcp:2.0"


def test_allowed_hosts():
    assert guard.host_allowed("api.acme.com", ["api.acme.com"])
    assert guard.host_allowed("eu.api.acme.com", ["*.acme.com"]) and not guard.host_allowed("acme.com", ["*.acme.com"])
    assert not guard.host_allowed("api.acme.com.evil.io", ["api.acme.com"])
    assert not guard.host_allowed("evilacme.com", ["*.acme.com"])


class Site(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")


async def test_the_egress_proxy():
    site = ThreadingHTTPServer(("127.0.0.1", 0), Site)
    threading.Thread(target=site.serve_forever, daemon=True).start()
    grants = {"inst-a": guard.Grant(secret="pw-a", hosts=["api.acme.com"])}
    proxy = guard.EgressProxy(lookup=grants.get, host="127.0.0.1", port=0)
    port = await proxy.start()
    try:
        def via(user, pw):
            return httpx.AsyncClient(proxy=f"http://{user}:{pw}@127.0.0.1:{port}", timeout=10)
        async with via("inst-a", "pw-a") as c:          # a test-only host goes through
            r = await c.get(f"http://127.0.0.1:{site.server_address[1]}/")
            assert r.status_code == 200 and r.text == "ok"
            r = await c.get("http://example.org/")       # a site it wasn't approved for
            assert r.status_code == 403 and "approved" in r.text
        assert "example.org isn't one of the sites" in grants["inst-a"].blocked[-1]
        async with via("inst-a", "wrong") as c:
            assert (await c.get("http://example.org/")).status_code == 407
        async with httpx.AsyncClient(proxy=f"http://127.0.0.1:{port}", timeout=10) as c:
            assert (await c.get("http://example.org/")).status_code == 407
    finally:
        await proxy.close()
        site.shutdown()
    with pytest.raises(guard.Blocked):
        await guard.resolve_public("10.1.2.3", 443)


NPM_SRI = "sha512-" + "A" * 86 + "=="
PYPI_SHA = "sha256:" + "a" * 64
OCI_SHA = "sha256:" + "b" * 64


def test_a_pinned_release_is_checked_before_it_runs():
    """S6: an approval's fingerprint goes into the instance, which verifies the download before running it."""
    image, cmd, env = runner.image_and_command(runner.Package(registryType="npm", identifier="@acme/x", version="1.2.3",
                                                              integrity=NPM_SRI))
    assert cmd[:2] == ["sh", "-c"] and "npm pack" in cmd[2] and "process.exit(3)" in cmd[2]
    assert env["KV_PKG"] == "@acme/x@1.2.3" and env["KV_INTEGRITY"] == NPM_SRI
    image, cmd, env = runner.image_and_command(runner.Package(registryType="pypi", identifier="acme-mcp", version="2.0",
                                                              integrity=PYPI_SHA, file="acme_mcp-2.0-py3-none-any.whl"))
    assert cmd[:2] == ["python", "-c"] and "sha256" in cmd[2] and env["KV_FILE"].endswith(".whl")
    image, cmd, _ = runner.image_and_command(runner.Package(registryType="oci", identifier="ghcr.io/acme/mcp:1.0",
                                                            version="1.0", integrity=OCI_SHA))
    assert image == f"ghcr.io/acme/mcp@{OCI_SHA}" and cmd == []           # by digest, never by tag
    with pytest.raises(runner.HTTPException):                             # a malformed fingerprint is refused
        runner.validate(runner.StartIn(package=runner.Package(registryType="npm", identifier="x", version="1",
                                                              integrity="md5-abc")))


async def test_the_control_api_never_answers_over_a_sandbox_network(monkeypatch):
    """S7: a request arriving on one of the runner's sandbox addresses gets nothing, token or not."""
    monkeypatch.setattr(runner, "LOCAL", False)
    monkeypatch.setattr(runner, "_sandbox_ips", {"testserver"})
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=runner.app), base_url="http://testserver") as c:
        r = await c.put(f"/instances/{uuid.uuid4()}", json=CFG, headers=AUTH)
        assert r.status_code == 404
    monkeypatch.setattr(runner, "_sandbox_ips", set())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=runner.app), base_url="http://testserver") as c:
        assert (await c.get("/healthz")).status_code == 200
