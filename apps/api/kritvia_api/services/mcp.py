"""Connected apps through MCP (the Model Context Protocol): a business adds the address of an app's MCP
server (HubSpot, Zoho, Notion, Shopify, a custom one…) and the general assistant can use that app's tools.

Kinds of app (patch 0095, the App store): `mcp` (an https MCP server; no auth, a bearer token, the app's own
header, basic, or OAuth via services/mcp_oauth.py), `hosted` (a reviewed package run in services/mcp-runner,
url runner:<id>), and `openapi` (any web app by its OpenAPI description, services/openapi_app.py).

Transport: MCP "Streamable HTTP" (JSON-RPC 2.0 over POST; the answer comes back as JSON or as a short
server-sent-event stream). Only what the assistant needs: initialize, tools/list, tools/call.

Safety:
  - Addresses must be https and resolve only to public internet addresses (no localhost, private ranges,
    link-local or cloud metadata, including IPv4-mapped and NAT64 forms of those). Checked when the app is
    added, and again by the connection itself, which connects only to the address it has just checked
    (services/netguard.py), so a DNS answer that changes in between can't redirect it. Redirects are not
    followed.
  - A read-only tool runs straight away; every other tool is a "send" action: an approval card that a person
    always has to look at, whatever trust the assistant has earned. A server's own readOnlyHint counts only
    for apps Kritvia has checked (trusts_read_only); on a custom server every tool asks first.
  - The app's token is encrypted with the business's key and never shown again; tool results are
    outside text for the model (the router's injection guard screens them).
  - Responses are capped in size and time.
"""
from __future__ import annotations

import asyncio
import base64
import json
import re
import socket
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

import httpx
from sqlalchemy import text

from kritvia_api.engine.tools import Capability
from kritvia_api.services import netguard

if TYPE_CHECKING:
    from kritvia_api.engine.context import RunContext

PREFIX = "app."                     # assistant tool names: app.<server>.<tool>
TOKEN_PURPOSE = "mcp.token"
PROTOCOL_VERSION = "2025-06-18"
MAX_TOOLS = 40
MAX_BYTES = 1_000_000
TIMEOUT_S = 20.0
NAME_RE = re.compile(r"^[a-z][a-z0-9_]{1,23}$")
transport: httpx.AsyncBaseTransport | None = None     # tests inject a mock


class McpError(Exception):
    pass


class NeedsAuth(McpError):
    """The app's OAuth sign-in has expired and couldn't be refreshed (the app is now marked 'needs_auth')."""


class NotStarted(McpError):
    """The MCP runner has no instance for this hosted app (it restarted): configure it and try again."""


@dataclass
class AppTool:
    server: str
    name: str
    description: str
    read_only: bool
    fields: dict[str, str]
    required: tuple[str, ...]

    @property
    def full_name(self) -> str:
        return f"{PREFIX}{self.server}.{self.name}"


# ------------------------------------------------------------------------------- addresses --
async def resolve(host: str) -> list[str]:
    """The addresses a host name resolves to (overridden in tests)."""
    infos = await asyncio.get_running_loop().getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    return sorted({i[4][0] for i in infos})


async def check_url(url: str) -> str:
    """The URL if it is https and every address it resolves to is on the public internet."""
    u = urlparse(url.strip())
    if u.scheme != "https" or not u.hostname:
        raise McpError("the address must start with https://")
    if u.username or u.password:
        raise McpError("put the token in the token field, not in the address")
    try:
        addrs = await resolve(u.hostname)
    except OSError:
        raise McpError(f"{u.hostname} could not be found") from None
    if not addrs:
        raise McpError(f"{u.hostname} could not be found")
    if not netguard.all_public(addrs):
        raise McpError("that address points inside a private network, which isn't allowed")
    return url.strip()


async def _resolve_now(host: str) -> list[str]:
    return await resolve(host)      # looked up when called, so a test's resolve() applies


def http_client(timeout: float, mock: httpx.AsyncBaseTransport | None = None) -> httpx.AsyncClient:
    """A client for addresses a customer typed: no redirects, and every connection goes only to a public
    address checked at the moment it opens (services/netguard.py). Tests pass a mock transport."""
    return httpx.AsyncClient(transport=mock or netguard.guarded_transport(_resolve_now), timeout=timeout,
                             follow_redirects=False)


# --------------------------------------------------------------------------------- protocol --
def auth_headers(auth: str, secret: str | None, header_name: str | None = None) -> dict[str, str]:
    """How an app's token is sent: Authorization: Bearer, a header of the app's own, or basic auth
    ("user:password", or an API key and secret)."""
    if not secret or auth == "none":
        return {}
    if auth == "header" and header_name:
        return {header_name: secret}
    if auth == "basic":
        return {"Authorization": "Basic " + base64.b64encode(secret.encode()).decode()}
    return {"Authorization": f"Bearer {secret}"}


def runner_endpoint(url: str) -> str:
    from kritvia_api.config import get_settings
    base = get_settings().mcp_runner_url.rstrip("/")
    if not base:
        raise McpError("hosted apps aren't switched on on this server (MCP_RUNNER_URL)")
    return f"{base}/mcp/{url.removeprefix('runner:')}"


def runner_headers() -> dict[str, str]:
    from kritvia_api.config import get_settings
    return {"Authorization": f"Bearer {get_settings().mcp_runner_token}"}


class Client:
    """One MCP session: initialize, then list or call tools. `url` is an https address, or runner:<id> for
    an app hosted in Kritvia's sandboxed MCP runner."""

    def __init__(self, url: str, token: str | None = None, *, headers: dict[str, str] | None = None) -> None:
        self.url, self.session_id = url, None
        self.hosted = url.startswith("runner:")
        self.extra = dict(headers if headers is not None else auth_headers("bearer", token))
        if self.hosted:
            self.extra.update(runner_headers())
        self._ids = 0

    def _headers(self) -> dict[str, str]:
        h = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json",
             "MCP-Protocol-Version": PROTOCOL_VERSION, **self.extra}
        if self.session_id:
            h["Mcp-Session-Id"] = self.session_id
        return h

    async def _post(self, client: httpx.AsyncClient, msg: dict[str, Any]) -> dict[str, Any] | None:
        if self.hosted:
            target = runner_endpoint(self.url)
        else:
            target = await check_url(self.url)
        try:
            r = await client.post(target, json=msg, headers=self._headers())
        except httpx.TransportError as exc:
            raise McpError(f"could not reach the app ({type(exc).__name__})") from exc
        if self.hosted and r.status_code == 409:
            raise NotStarted("the app isn't running yet")
        if r.status_code in (401, 403):
            raise McpError("the app refused the token (check it in the App store)")
        if r.status_code >= 400 and r.status_code != 202:
            raise McpError(f"the app answered HTTP {r.status_code}")
        if len(r.content) > MAX_BYTES:
            raise McpError("the app's answer was too large")
        sid = r.headers.get("mcp-session-id")
        if sid:
            self.session_id = sid[:200]
        if "id" not in msg or r.status_code == 202 or not r.content:
            return None
        if r.headers.get("content-type", "").startswith("text/event-stream"):
            found = None
            for line in r.text.splitlines():
                if line.startswith("data:"):
                    try:
                        m = json.loads(line[5:].strip())
                    except ValueError:
                        continue
                    if isinstance(m, dict) and m.get("id") == msg["id"]:
                        found = m
            if found is None:
                raise McpError("the app sent no answer")
            data = found
        else:
            try:
                data = r.json()
            except ValueError:
                raise McpError("the app's answer wasn't valid JSON") from None
        if not isinstance(data, dict):
            raise McpError("the app's answer wasn't understood")
        if data.get("error"):
            raise McpError(f"the app said: {str((data['error'] or {}).get('message', ''))[:200]}")
        return data.get("result") or {}

    async def _request(self, client: httpx.AsyncClient, method: str, params: dict | None = None) -> dict:
        self._ids += 1
        return await self._post(client, {"jsonrpc": "2.0", "id": self._ids, "method": method,
                                         "params": params or {}}) or {}

    async def _open(self, client: httpx.AsyncClient) -> None:
        await self._request(client, "initialize", {
            "protocolVersion": PROTOCOL_VERSION, "capabilities": {},
            "clientInfo": {"name": "Kritvia", "version": "1.0"}})
        await self._post(client, {"jsonrpc": "2.0", "method": "notifications/initialized"})

    def _http(self) -> httpx.AsyncClient:
        if self.hosted:     # Kritvia's own runner on the internal network, not a customer's address
            return httpx.AsyncClient(transport=transport, timeout=TIMEOUT_S, follow_redirects=False)
        return http_client(TIMEOUT_S, transport)

    async def list_tools(self, server: str) -> list[AppTool]:
        out: list[AppTool] = []
        async with self._http() as client:
            await self._open(client)
            cursor = None
            for _ in range(3):
                res = await self._request(client, "tools/list", {"cursor": cursor} if cursor else {})
                for t in res.get("tools") or []:
                    tool = _app_tool(server, t)
                    if tool:
                        out.append(tool)
                cursor = res.get("nextCursor")
                if not cursor or len(out) >= MAX_TOOLS:
                    break
        return out[:MAX_TOOLS]

    async def call(self, name: str, arguments: dict[str, Any]) -> str:
        async with self._http() as client:
            await self._open(client)
            res = await self._request(client, "tools/call", {"name": name, "arguments": arguments})
        parts = []
        for c in res.get("content") or []:
            if isinstance(c, dict) and c.get("type") == "text":
                parts.append(str(c.get("text", "")))
        if not parts and res.get("structuredContent") is not None:
            parts.append(json.dumps(res["structuredContent"], ensure_ascii=False, default=str))
        body = "\n".join(parts)[:20000]
        if res.get("isError"):
            raise McpError(f"the app reported an error: {body[:300]}")
        return body


def _app_tool(server: str, t: dict[str, Any]) -> AppTool | None:
    name = str(t.get("name") or "")
    if not re.fullmatch(r"[A-Za-z0-9_.\-]{1,64}", name):
        return None
    schema = t.get("inputSchema") or {}
    props = schema.get("properties") or {}
    fields = {}
    for k, v in list(props.items())[:12]:
        if re.fullmatch(r"[A-Za-z0-9_\-]{1,40}", str(k)):
            fields[str(k)] = str((v or {}).get("description") or (v or {}).get("type") or "")[:120]
    required = tuple(str(x) for x in (schema.get("required") or []) if str(x) in fields)
    ann = t.get("annotations") or {}
    return AppTool(server=server, name=name, description=str(t.get("description") or name)[:300],
                   read_only=ann.get("readOnlyHint") is True, fields=fields, required=required)


def tool_to_json(t: AppTool) -> dict[str, Any]:
    return {"name": t.name, "description": t.description, "read_only": t.read_only, "fields": t.fields,
            "required": list(t.required)}


def tool_from_json(server: str, d: dict[str, Any]) -> AppTool:
    return AppTool(server=server, name=d["name"], description=d.get("description", ""),
                   read_only=bool(d.get("read_only")), fields=dict(d.get("fields") or {}),
                   required=tuple(d.get("required") or ()))


# ---------------------------------------------------------------------- the four kinds of app --
@dataclass
class Link:
    """How to reach one installed app, with its secret already decrypted."""
    id: uuid.UUID | None
    kind: str                         # mcp | hosted | openapi
    url: str
    headers: dict[str, str]
    spec: dict[str, Any] | None = None
    runner: dict[str, Any] | None = None   # hosted: {package, env, egress_hosts}


async def configure_runner(instance: str, cfg: dict[str, Any]) -> None:
    """Start (or restart) a hosted app's sandboxed instance in the MCP runner."""
    from kritvia_api.config import get_settings
    base = get_settings().mcp_runner_url.rstrip("/")
    if not base:
        raise McpError("hosted apps aren't switched on on this server (MCP_RUNNER_URL)")
    async with httpx.AsyncClient(transport=transport, timeout=120, follow_redirects=False) as client:
        try:
            r = await client.put(f"{base}/instances/{instance}", json=cfg, headers=runner_headers())
        except httpx.TransportError as exc:
            raise McpError(f"the app runner couldn't be reached ({type(exc).__name__})") from None
    if r.status_code >= 400:
        try:
            why = str(r.json().get("detail", ""))[:200]
        except ValueError:
            why = ""
        raise McpError(f"the app couldn't be started{': ' + why if why else ''}")


async def stop_runner(instance: str) -> None:
    from kritvia_api.config import get_settings
    base = get_settings().mcp_runner_url.rstrip("/")
    if not base:
        return
    try:
        async with httpx.AsyncClient(transport=transport, timeout=30) as client:
            await client.delete(f"{base}/instances/{instance}", headers=runner_headers())
    except httpx.TransportError:
        pass


async def link_tools(link: Link, server: str) -> list[AppTool]:
    if link.kind == "openapi":
        from kritvia_api.services import openapi_app
        return openapi_app.tools(link.spec or {}, server)
    client = Client(link.url, headers=link.headers)
    if link.kind == "hosted":
        try:
            return await client.list_tools(server)
        except NotStarted:
            await configure_runner(link.url.removeprefix("runner:"), link.runner or {})
            return await Client(link.url, headers=link.headers).list_tools(server)
    return await client.list_tools(server)


async def link_call(link: Link, tool: str, args: dict[str, Any]) -> str:
    if link.kind == "openapi":
        from kritvia_api.services import openapi_app
        return await openapi_app.call(link.spec or {}, tool, args, link.headers)
    if link.kind == "hosted":
        try:
            return await Client(link.url, headers=link.headers).call(tool, args)
        except NotStarted:
            await configure_runner(link.url.removeprefix("runner:"), link.runner or {})
    return await Client(link.url, headers=link.headers).call(tool, args)


async def hosted_config(conn, catalog_id: str | None, env: dict[str, str]) -> dict[str, Any]:
    """What the runner needs to start a hosted app: the reviewed package, the hosts it may reach, its settings."""
    row = (await conn.execute(text(
        "SELECT package, egress_hosts FROM app_catalog WHERE id = :c AND kind = 'hosted'"
        " AND (status = 'approved' OR (source = 'kritvia' AND status = 'listed'))"), {"c": catalog_id})).first()
    if row is None or not row.package:
        raise McpError("this app hasn't been approved by Kritvia's team")
    return {"package": row.package, "egress_hosts": list(row.egress_hosts or []), "env": env}


async def load_link(conn, crypto, venture_id: uuid.UUID, row: Any) -> Link:
    """A connection for an mcp_servers row (id, kind, url, auth, header_name, token_enc, oauth_enc, spec,
    catalog_id). OAuth tokens are refreshed when they are about to expire; if that fails the app is marked
    'needs_auth' and someone signs in again in the App store."""
    secret = None
    if row.token_enc:
        secret = (await crypto.decrypt(venture_id, TOKEN_PURPOSE, row.token_enc)).decode()
    kind, auth = getattr(row, "kind", "mcp") or "mcp", getattr(row, "auth", "bearer") or "bearer"
    if kind == "hosted":
        try:
            env = json.loads(secret or "{}")
        except ValueError:
            env = {}
        cfg = await hosted_config(conn, row.catalog_id, env)
        return Link(row.id, kind, row.url, {}, runner=cfg)
    if auth == "oauth":
        from kritvia_api.services import mcp_oauth
        if not row.oauth_enc:
            raise McpError("sign in to this app again in the App store")
        tok = json.loads((await crypto.decrypt(venture_id, mcp_oauth.PURPOSE, row.oauth_enc)).decode())
        if mcp_oauth.needs_refresh(tok):
            try:
                tok = await mcp_oauth.refresh(tok)
            except McpError:
                await conn.execute(text("SELECT private.mcp_save_oauth(:id, NULL, 'needs_auth')"), {"id": row.id})
                raise NeedsAuth("the app's sign-in has expired: sign in again in the App store") from None
            enc = await crypto.encrypt(venture_id, mcp_oauth.PURPOSE, json.dumps(tok))
            await conn.execute(text("SELECT private.mcp_save_oauth(:id, :e, 'active')"), {"id": row.id, "e": enc})
        headers = {"Authorization": f"Bearer {tok['access_token']}"}
    else:
        headers = auth_headers(auth, secret, row.header_name)
    return Link(row.id, kind, row.url, headers, spec=row.spec)


ROW_COLS = "id, name, kind, url, auth, header_name, token_enc, oauth_enc, spec, catalog_id, tools"


# --------------------------------------------------------------------- what the assistant sees --
def _norm(url: str | None) -> str:
    u = urlparse((url or "").strip())
    return f"{u.scheme.lower()}://{(u.hostname or '').lower()}{u.path.rstrip('/')}"


def trusts_read_only(kind: str | None, url: str | None) -> bool:
    """Whether a tool's 'read-only' mark may let it run without an approval. Only for apps whose tools Kritvia
    has checked: OpenAPI apps (Kritvia itself marks GET operations read-only), hosted apps (reviewed packages
    run in the sandbox) and the remote servers on Kritvia's own list (services/app_catalog.KRITVIA_APPS,
    matched by address, never by a catalog id the caller sent). A custom server's own readOnlyHint is not
    trusted, so a server that mislabels a tool can't skip the approval card: every one of its tools asks."""
    if kind in ("openapi", "hosted"):
        return True
    from kritvia_api.services.app_catalog import KRITVIA_APPS
    return _norm(url) in {_norm(a["url"]) for a in KRITVIA_APPS}


async def _servers(ctx: RunContext) -> list[Any]:
    async with ctx.tx() as conn:
        return (await conn.execute(text(
            "SELECT id, name, kind, url, tools FROM mcp_servers WHERE venture_id = :v AND status = 'active'"
            " ORDER BY name"), {"v": ctx.venture_id})).all()


async def tools_for(ctx: RunContext) -> dict[str, tuple[Capability, str, dict[str, str], tuple[str, ...]]]:
    """name -> (capability, description, fields, required) for every tool of the business's connected apps."""
    out = {}
    for s in await _servers(ctx):
        trusted = trusts_read_only(s.kind, s.url)
        for d in (s.tools or [])[:MAX_TOOLS]:
            t = tool_from_json(s.name, d)
            out[t.full_name] = (Capability.READ if t.read_only and trusted else Capability.SEND,
                                f"[connected app {s.name}] {t.description}", t.fields, t.required)
    return out


def split_name(full: str) -> tuple[str, str]:
    if not full.startswith(PREFIX) or full.count(".") < 2:
        raise McpError(f"{full!r} is not a connected-app tool")
    server, _, tool = full[len(PREFIX):].partition(".")
    return server, tool


async def call(ctx: RunContext, full_name: str, args: dict[str, Any]) -> str:
    """Call one connected-app tool for this business (read-only tools directly; others only from mcp.call
    with an approval)."""
    server, tool = split_name(full_name)
    async with ctx.tx() as conn:
        row = (await conn.execute(text(
            f"SELECT {ROW_COLS} FROM mcp_servers WHERE venture_id = :v AND name = :n AND status = 'active'"),
            {"v": ctx.venture_id, "n": server})).first()
        if row is None:
            raise McpError(f"the connected app {server!r} isn't set up")
        if not any(d.get("name") == tool for d in (row.tools or [])):
            raise McpError(f"the app {server!r} has no tool {tool!r}")
        try:
            link = await load_link(conn, ctx.crypto(conn), ctx.venture_id, row)
        except NeedsAuth as exc:
            expired = exc                      # keep the 'needs_auth' mark: leave the transaction normally
        else:
            expired = None
    if expired is not None:
        raise expired
    clean = {k: v for k, v in args.items() if k != "mcp_tool"}
    return await link_call(link, tool, clean)


def new_id() -> uuid.UUID:
    return uuid.uuid4()


__all__ = ["PREFIX", "McpError", "NeedsAuth", "NotStarted", "AppTool", "Client", "Link", "check_url", "tools_for", "call",
           "split_name", "tool_to_json", "tool_from_json", "NAME_RE", "TOKEN_PURPOSE", "auth_headers", "load_link",
           "link_tools", "link_call", "hosted_config", "configure_runner", "stop_runner", "ROW_COLS",
           "trusts_read_only", "http_client"]
