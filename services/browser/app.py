"""Kritvia browser: a locked-down headless Chromium for the browser agent.

One job at a time (MAX_SESSIONS, default 1). Every session is a fresh incognito context: no cookies,
storage or logins carried over, no downloads, no service workers, no permissions, images and fonts not
loaded. All traffic goes through guard.EgressProxy (public addresses on ports 80/443 only, one DNS
lookup per connection, a data allowance). A session is READ-ONLY unless it was started for an approved
submit: Chromium's own requests other than GET/HEAD/OPTIONS are refused, so a click can't send a form,
place an order or post anything. Password, card, OTP and similar fields are never filled. Sessions end
after IDLE_S without use or MAX_LIFE_S in all, and after MAX_ACTIONS actions.

Endpoints (bearer BROWSER_TOKEN; internal network only):
  POST   /sessions                    {}                         -> {id}
  POST   /sessions/{id}/goto          {url}                      -> page
  POST   /sessions/{id}/act           {action, ref?, text?, key?} -> page
  DELETE /sessions/{id}
  POST   /submit                      {url, fields, button}      -> page (one approved form, then closed)
  GET    /healthz
"""
from __future__ import annotations

import asyncio
import contextlib
import hmac
import os
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from guard import Blocked, EgressProxy, check_url

TOKEN = os.environ.get("BROWSER_TOKEN", "")
MAX_SESSIONS = int(os.environ.get("BROWSER_MAX_SESSIONS", "1"))
IDLE_S = int(os.environ.get("BROWSER_IDLE_S", "180"))
MAX_LIFE_S = int(os.environ.get("BROWSER_MAX_LIFE_S", "600"))
MAX_ACTIONS = 40
MAX_ELEMENTS = 80
NAV_TIMEOUT_MS = 20_000
ACT_TIMEOUT_MS = 8_000
KEYS = {"Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "PageDown", "PageUp", "Space"}
READ_METHODS = {"GET", "HEAD", "OPTIONS"}
SKIP_TYPES = {"image", "media", "font"}
SNAPSHOT_JS = (Path(__file__).parent / "snapshot.js").read_text()
UA_SUFFIX = " KritviaAgent/1.0 (+https://app.sitelytc.com/bot)"

@contextlib.asynccontextmanager
async def _lifespan(_app):
    task = asyncio.get_running_loop().create_task(_reaper())
    yield
    task.cancel()


app = FastAPI(title="Kritvia browser", version="1.0.0", lifespan=_lifespan)


@dataclass
class Session:
    id: str
    writes: bool
    proxy: EgressProxy
    context: Any
    page: Any
    created: float = field(default_factory=time.monotonic)
    touched: float = field(default_factory=time.monotonic)
    actions: int = 0
    refused: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    last: dict[int, dict[str, Any]] = field(default_factory=dict)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


_pw: Any = None
_browser: Any = None
_sessions: dict[str, Session] = {}
_start_lock = asyncio.Lock()


def _auth(authorization: str | None) -> None:
    if not TOKEN:
        raise HTTPException(503, "BROWSER_TOKEN not configured")
    if not hmac.compare_digest((authorization or "").removeprefix("Bearer ").strip(), TOKEN):
        raise HTTPException(401, "bad token")


async def _chromium():
    global _pw, _browser
    async with _start_lock:
        if _browser is None or not _browser.is_connected():
            from playwright.async_api import async_playwright
            if _pw is None:
                _pw = await async_playwright().start()
            args = ["--disable-dev-shm-usage", "--disable-gpu", "--disable-extensions", "--no-first-run",
                    "--disable-background-networking", "--disable-sync", "--disable-default-apps",
                    "--disable-component-update", "--disable-domain-reliability", "--metrics-recording-only",
                    "--disable-features=Translate,MediaRouter,OptimizationHints,InterestFeedContentSuggestions",
                    "--deny-permission-prompts"]
            _browser = await _pw.chromium.launch(
                headless=True, args=args,
                chromium_sandbox=os.environ.get("BROWSER_CHROMIUM_SANDBOX", "0") == "1")
    return _browser


async def _close(s: Session) -> None:
    _sessions.pop(s.id, None)
    with contextlib.suppress(Exception):
        await asyncio.wait_for(s.context.close(), 10)
    await s.proxy.close()


async def _reaper() -> None:
    while True:
        await asyncio.sleep(10)
        now = time.monotonic()
        for s in list(_sessions.values()):
            if now - s.touched > IDLE_S or now - s.created > MAX_LIFE_S:
                await _close(s)


async def _open(writes: bool) -> Session:
    if len(_sessions) >= MAX_SESSIONS:
        raise HTTPException(429, "busy: another browser job is running")
    browser = await _chromium()
    proxy = EgressProxy()
    port = await proxy.start()
    agent = (f"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{browser.version}"
             " Safari/537.36" + UA_SUFFIX)
    context = await browser.new_context(
        proxy={"server": f"http://127.0.0.1:{port}"}, accept_downloads=False, service_workers="block",
        viewport={"width": 1280, "height": 900}, locale="en-IN", timezone_id="Asia/Kolkata", user_agent=agent,
        java_script_enabled=True, bypass_csp=False, permissions=[])
    context.set_default_timeout(ACT_TIMEOUT_MS)
    context.set_default_navigation_timeout(NAV_TIMEOUT_MS)
    page = await context.new_page()
    s = Session(id=uuid.uuid4().hex, writes=writes, proxy=proxy, context=context, page=page)

    async def route(r) -> None:
        req = r.request
        if req.resource_type in SKIP_TYPES:
            await r.abort("blockedbyclient")
            return
        try:      # Chromium never sends loopback through a proxy, so addresses are checked here too
            check_url(req.url)
        except Blocked as exc:
            if str(exc) not in s.refused:
                s.refused.append(str(exc))
                del s.refused[:-10]
            await r.abort("blockedbyclient")
            return
        if req.method.upper() not in READ_METHODS and not s.writes:
            why = f"the page tried to send data ({req.method} to {req.url.split('?')[0][:120]}); sending needs a yes"
            if why not in s.refused:
                s.refused.append(why)
                del s.refused[:-10]
            await r.abort("blockedbyclient")
            return
        await r.continue_()

    await context.route("**/*", route)

    def on_page(p) -> None:     # a link that opens a new tab: carry on in the new tab
        s.page = p
        s.notes.append("the page opened a new tab; continuing there")

    async def on_dialog(d) -> None:
        s.notes.append(f"the page showed a {d.type} box, dismissed: {d.message[:120]}")
        with contextlib.suppress(Exception):
            await d.dismiss()

    context.on("page", on_page)
    context.on("dialog", on_dialog)
    _sessions[s.id] = s
    return s


async def _settle(page) -> None:
    with contextlib.suppress(Exception):
        await page.wait_for_load_state("domcontentloaded", timeout=10_000)
    with contextlib.suppress(Exception):
        await page.wait_for_load_state("networkidle", timeout=2_500)


async def _snapshot(s: Session) -> dict[str, Any]:
    page = s.page
    if page.url.startswith("chrome-error:"):       # a refused or failed navigation: back to where it was
        with contextlib.suppress(Exception):
            await page.go_back(wait_until="domcontentloaded", timeout=10_000)
        s.notes.append("that didn't open (refused or failed), so the browser went back")
    if not page.url.startswith(("http://", "https://", "about:blank")):
        await page.goto("about:blank")
        s.notes.append("that page isn't a web page and was closed")
    try:
        snap = await page.evaluate(SNAPSHOT_JS, MAX_ELEMENTS)
    except Exception as exc:  # noqa: BLE001 - e.g. the page navigated while we read it
        await _settle(page)
        try:
            snap = await page.evaluate(SNAPSHOT_JS, MAX_ELEMENTS)
        except Exception:  # noqa: BLE001
            raise HTTPException(502, f"couldn't read the page: {type(exc).__name__}") from None
    s.last = {e["ref"]: e for e in snap["elements"]}
    blocked = list(dict.fromkeys(s.proxy.blocked + s.refused))
    notes, s.notes = s.notes[-5:], []
    return {**snap, "blocked": blocked[-10:], "notes": notes, "actions_left": MAX_ACTIONS - s.actions,
            "writes": s.writes}


def _get(sid: str) -> Session:
    s = _sessions.get(sid)
    if s is None:
        raise HTTPException(404, "session ended")
    s.touched = time.monotonic()
    s.actions += 1
    if s.actions > MAX_ACTIONS:
        raise HTTPException(429, "this session has done its actions; start a new one")
    return s


class OpenIn(BaseModel):
    pass


class GotoIn(BaseModel):
    url: str = Field(min_length=4, max_length=2000)


class ActIn(BaseModel):
    action: Literal["click", "type", "select", "check", "press", "scroll_down", "scroll_up", "back"]
    ref: int | None = Field(default=None, ge=1, le=MAX_ELEMENTS)
    text: str | None = Field(default=None, max_length=2000)
    key: str | None = None


class FieldIn(BaseModel):
    selector: str = Field(min_length=1, max_length=600)
    value: str | bool = ""
    kind: Literal["fill", "select", "check"] = "fill"


class SubmitIn(BaseModel):
    url: str = Field(min_length=4, max_length=2000)
    fields: list[FieldIn] = Field(default_factory=list, max_length=30)
    button: str = Field(min_length=1, max_length=600)


SENSITIVE_CHECK = """(el) => {
  const t = (el.getAttribute('type') || '').toLowerCase();
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
  const n = `${el.getAttribute('name') || ''} ${el.id || ''} ${el.getAttribute('aria-label') || ''} ${el.placeholder || ''}`;
  return t === 'password' || t === 'file' || /^(current-password|new-password|one-time-code|cc-|transaction-)/.test(ac)
    || /(pass(word|code)?|pwd|card|cvv|cvc|otp|one.?time|\\bpin\\b|aadha?ar|\\bpan\\b|ifsc|account.?(no|number)|secret|token)/i.test(n);
}"""


async def _refuse_sensitive(locator) -> None:
    if await locator.evaluate(SENSITIVE_CHECK):
        raise HTTPException(422, "that is a password, card, OTP or similar field; the browser agent never fills those")


@app.post("/sessions")
async def open_session(body: OpenIn | None = None, authorization: str | None = Header(default=None)) -> dict:
    _auth(authorization)
    s = await _open(writes=False)
    return {"id": s.id, "max_actions": MAX_ACTIONS}


@app.post("/sessions/{sid}/goto")
async def goto(sid: str, body: GotoIn, authorization: str | None = Header(default=None)) -> dict:
    _auth(authorization)
    s = _get(sid)
    async with s.lock:
        try:
            url = check_url(body.url)
        except Blocked as exc:
            raise HTTPException(422, str(exc)) from None
        try:
            await s.page.goto(url, wait_until="domcontentloaded")
        except Exception as exc:  # noqa: BLE001 - timeouts, refused connections: the agent is told
            s.notes.append(f"the page didn't load fully ({type(exc).__name__})")
        await _settle(s.page)
        return await _snapshot(s)


@app.post("/sessions/{sid}/act")
async def act(sid: str, body: ActIn, authorization: str | None = Header(default=None)) -> dict:
    _auth(authorization)
    s = _get(sid)
    async with s.lock:
        page = s.page
        loc = None
        if body.action in ("click", "type", "select", "check"):
            if body.ref is None or body.ref not in s.last:
                raise HTTPException(422, "no such element on the page; look at the latest page")
            loc = page.locator(f'[data-kv-ref="{body.ref}"]').first
        try:
            if body.action == "click":
                before = len(s.context.pages)
                await loc.click()
                await asyncio.sleep(0.4)
                if len(s.context.pages) > before:      # it opened a new tab (on_page moved us there)
                    with contextlib.suppress(Exception):
                        await s.page.wait_for_load_state("domcontentloaded", timeout=10_000)
                    for old in s.context.pages[:-3]:   # keep at most 3 tabs open
                        with contextlib.suppress(Exception):
                            await old.close()
            elif body.action == "type":
                await _refuse_sensitive(loc)
                await loc.fill(body.text or "")
            elif body.action == "select":
                await _refuse_sensitive(loc)
                await loc.select_option(label=body.text or "")
            elif body.action == "check":
                await loc.set_checked(bool(body.text not in (None, "", "false", "no", "off")))
            elif body.action == "press":
                if body.key not in KEYS:
                    raise HTTPException(422, f"keys that can be pressed: {', '.join(sorted(KEYS))}")
                await page.keyboard.press(body.key)
            elif body.action == "scroll_down":
                await page.mouse.wheel(0, 800)
            elif body.action == "scroll_up":
                await page.mouse.wheel(0, -800)
            elif body.action == "back":
                await page.go_back()
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001 - the agent is told and tries something else
            s.notes.append(f"{body.action} didn't work ({type(exc).__name__}: {str(exc).splitlines()[0][:120]})")
        await _settle(s.page)
        return await _snapshot(s)


@app.delete("/sessions/{sid}")
async def close_session(sid: str, authorization: str | None = Header(default=None)) -> dict:
    _auth(authorization)
    s = _sessions.get(sid)
    if s is not None:
        await _close(s)
    return {"closed": True}


@app.post("/submit")
async def submit(body: SubmitIn, authorization: str | None = Header(default=None)) -> dict:
    """An approved form: open the page in a fresh session that may send data, fill exactly the approved
    fields, press exactly the approved button, return the page that follows, and close."""
    _auth(authorization)
    try:
        url = check_url(body.url)
    except Blocked as exc:
        raise HTTPException(422, str(exc)) from None
    s = await _open(writes=True)
    try:
        page = s.page
        await page.goto(url, wait_until="domcontentloaded")
        await _settle(page)
        for f in body.fields:
            loc = page.locator(f.selector).first
            if await loc.count() == 0:
                raise HTTPException(409, "the form has changed since it was approved; nothing was sent")
            await _refuse_sensitive(loc)
            if f.kind == "select":
                await loc.select_option(label=str(f.value))
            elif f.kind == "check":
                await loc.set_checked(bool(f.value))
            else:
                await loc.fill(str(f.value))
        button = page.locator(body.button).first
        if await button.count() == 0:
            raise HTTPException(409, "the form's button isn't there any more; nothing was sent")
        await button.click()
        await _settle(s.page)
        out = await _snapshot(s)
        return {**out, "sent": True}
    finally:
        await _close(s)


@app.get("/healthz")
async def healthz() -> dict:
    return {"status": "ok", "busy": len(_sessions) >= MAX_SESSIONS, "sessions": len(_sessions),
            "configured": bool(TOKEN)}
