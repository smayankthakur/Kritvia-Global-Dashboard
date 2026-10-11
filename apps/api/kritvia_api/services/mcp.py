"""Connected apps through MCP (the Model Context Protocol): a business adds the address of an app's MCP
server (HubSpot, Zoho, Notion, Shopify, a custom one…) and the general assistant can use that app's tools.

Transport: MCP "Streamable HTTP" (JSON-RPC 2.0 over POST; the answer comes back as JSON or as a short
server-sent-event stream). Only what the assistant needs: initialize, tools/list, tools/call.

Safety:
  - Addresses must be https and resolve only to public internet addresses (no localhost, private ranges,
    link-local or cloud metadata). Checked when the app is added and again before every call; redirects
    are not followed. (A DNS answer that changes between the check and the connection is a residual risk;
    the server's egress rules are the second line.)
  - A tool the server marks read-only (annotations.readOnlyHint) runs straight away; every other tool is a
    "send" action: an approval card that a person always has to look at, whatever trust the assistant has
    earned.
  - The app's token is encrypted with the business's key and never shown again; tool results are
    outside text for the model (the router's injection guard screens them).
  - Responses are capped in size and time.
"""
from __future__ import annotations

import asyncio
import ipaddress
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
    for a in addrs:
        ip = ipaddress.ip_address(a)
        if not ip.is_global or ip.is_multicast:
            raise McpError("that address points inside a private network, which isn't allowed")
    return url.strip()


# --------------------------------------------------------------------------------- protocol --
class Client:
    """One MCP session: initialize, then list or call tools."""

    def __init__(self, url: str, token: str | None) -> None:
        self.url, self.token, self.session_id = url, token, None
        self._ids = 0

    def _headers(self) -> dict[str, str]:
        h = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json",
             "MCP-Protocol-Version": PROTOCOL_VERSION}
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        if self.session_id:
            h["Mcp-Session-Id"] = self.session_id
        return h

    async def _post(self, client: httpx.AsyncClient, msg: dict[str, Any]) -> dict[str, Any] | None:
        await check_url(self.url)
        try:
            r = await client.post(self.url, json=msg, headers=self._headers())
        except httpx.TransportError as exc:
            raise McpError(f"could not reach the app ({type(exc).__name__})") from exc
        if r.status_code in (401, 403):
            raise McpError("the app refused the token (check it in Connected apps)")
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
        return httpx.AsyncClient(transport=transport, timeout=TIMEOUT_S, follow_redirects=False)

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


# --------------------------------------------------------------------- what the assistant sees --
async def _servers(ctx: RunContext) -> list[Any]:
    async with ctx.tx() as conn:
        return (await conn.execute(text(
            "SELECT id, name, url, token_enc, tools FROM mcp_servers WHERE venture_id = :v AND status = 'active'"
            " ORDER BY name"), {"v": ctx.venture_id})).all()


async def tools_for(ctx: RunContext) -> dict[str, tuple[Capability, str, dict[str, str], tuple[str, ...]]]:
    """name -> (capability, description, fields, required) for every tool of the business's connected apps."""
    out = {}
    for s in await _servers(ctx):
        for d in (s.tools or [])[:MAX_TOOLS]:
            t = tool_from_json(s.name, d)
            out[t.full_name] = (Capability.READ if t.read_only else Capability.SEND,
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
            "SELECT id, url, token_enc, tools FROM mcp_servers WHERE venture_id = :v AND name = :n"
            " AND status = 'active'"), {"v": ctx.venture_id, "n": server})).first()
        if row is None:
            raise McpError(f"the connected app {server!r} isn't set up")
        if not any(d.get("name") == tool for d in (row.tools or [])):
            raise McpError(f"the app {server!r} has no tool {tool!r}")
        token = None
        if row.token_enc:
            token = (await ctx.crypto(conn).decrypt(ctx.venture_id, TOKEN_PURPOSE, row.token_enc)).decode()
    clean = {k: v for k, v in args.items() if k != "mcp_tool"}
    return await Client(row.url, token).call(tool, clean)


def new_id() -> uuid.UUID:
    return uuid.uuid4()


__all__ = ["PREFIX", "McpError", "AppTool", "Client", "check_url", "tools_for", "call", "split_name",
           "tool_to_json", "tool_from_json", "NAME_RE", "TOKEN_PURPOSE"]
