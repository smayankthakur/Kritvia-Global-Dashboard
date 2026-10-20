"""Network guard for hosted MCP apps: every connection an app makes goes through EgressProxy.

Each app instance has its own proxy credentials (HTTPS_PROXY=http://<instance>:<secret>@mcp-runner:8301) and its
own list of hosts, approved by Kritvia's team (plus the package registry it is installed from). The proxy
refuses any other host, resolves each allowed host ONCE, refuses it unless every address is public (no loopback,
private, link-local such as 169.254.169.254, carrier-grade NAT, multicast or reserved ranges), allows only port
443 (and 80 for plain http), and connects to the address it checked, so DNS rebinding doesn't help.
The app containers sit on an internal Docker network whose only way out is this proxy.
"""
from __future__ import annotations

import asyncio
import base64
import hmac
import ipaddress
import os
import socket
from dataclasses import dataclass, field
from typing import Callable
from urllib.parse import urlsplit

ALLOWED_PORTS = {80, 443}
MAX_BYTES = 500 * 1024 * 1024        # per instance, both directions, until it restarts
HEAD_LIMIT = 32 * 1024
IDLE_S = 300


class Blocked(Exception):
    pass


def _test_hosts() -> set[str]:
    # Only for this service's own tests (a local test server). Never set in production.
    return {h.strip() for h in os.environ.get("MCP_ALLOW_HOSTS_FOR_TESTS", "").split(",") if h.strip()}


def public_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    if isinstance(ip, ipaddress.IPv6Address) and ip in ipaddress.ip_network("64:ff9b::/96"):
        return public_ip(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF))
    return ip.is_global and not ip.is_multicast and not ip.is_reserved and not ip.is_loopback


def host_allowed(host: str, allowed: list[str]) -> bool:
    host = host.strip("[]").lower().rstrip(".")
    for a in allowed:
        a = a.lower()
        if a.startswith("*.") and (host.endswith(a[1:]) and host != a[2:]):
            return True
        if host == a:
            return True
    return False


async def resolve_public(host: str, port: int) -> str:
    host = host.strip("[]").lower()
    if host in _test_hosts():
        return host
    if port not in ALLOWED_PORTS:
        raise Blocked(f"port {port} isn't allowed")
    try:
        ipaddress.ip_address(host)
        raise Blocked("addresses must be site names, not numbers")
    except ValueError:
        pass
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror:
        raise Blocked(f"{host} doesn't exist") from None
    addrs = sorted({i[4][0] for i in infos})
    if not addrs:
        raise Blocked(f"{host} doesn't exist")
    for a in addrs:
        if not public_ip(ipaddress.ip_address(a.split("%")[0])):
            raise Blocked(f"{host} points to a private address")
    v4 = [a for a in addrs if ":" not in a]
    return (v4 or addrs)[0]


@dataclass
class Grant:
    secret: str
    hosts: list[str]
    bytes_used: int = 0
    blocked: list[str] = field(default_factory=list)


@dataclass
class EgressProxy:
    """One HTTP proxy for every instance; who is calling is told by the Proxy-Authorization header."""
    lookup: Callable[[str], Grant | None]
    host: str = "0.0.0.0"
    port: int = 8301
    _server: asyncio.AbstractServer | None = None

    async def start(self) -> int:
        self._server = await asyncio.start_server(self._handle, self.host, self.port)
        self.port = self._server.sockets[0].getsockname()[1]
        return self.port

    async def close(self) -> None:
        if self._server is not None:
            self._server.close()

    def _who(self, headers: list[str]) -> Grant | None:
        for h in headers:
            k, _, v = h.partition(":")
            if k.strip().lower() == "proxy-authorization":
                kind, _, cred = v.strip().partition(" ")
                if kind.lower() != "basic":
                    return None
                try:
                    user, _, pw = base64.b64decode(cred).decode().partition(":")
                except (ValueError, UnicodeDecodeError):
                    return None
                g = self.lookup(user)
                if g is not None and hmac.compare_digest(g.secret, pw):
                    return g
        return None

    @staticmethod
    def _refuse(code: str, why: str) -> bytes:
        body = f"Blocked by the Kritvia app guard: {why}".encode()
        extra = b"Proxy-Authenticate: Basic realm=\"kritvia\"\r\n" if code.startswith("407") else b""
        return (f"HTTP/1.1 {code}\r\n".encode() + extra + b"Content-Type: text/plain\r\nConnection: close\r\n"
                b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 60)
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, TimeoutError, asyncio.TimeoutError,
                ConnectionError):
            writer.close()
            return
        if len(head) > HEAD_LIMIT:
            writer.close()
            return
        try:
            line, *headers = head.decode("latin-1").split("\r\n")
            method, target, version = line.split(" ", 2)
        except ValueError:
            writer.close()
            return
        grant = self._who(headers)
        if grant is None:
            writer.write(self._refuse("407 Proxy Authentication Required", "unknown app"))
            await writer.drain()
            writer.close()
            return
        try:
            if grant.bytes_used > MAX_BYTES:
                raise Blocked("this app has used its data allowance")
            if method.upper() == "CONNECT":
                host, _, p = target.rpartition(":")
                port = int(p) if p.isdigit() else 443
                if not host_allowed(host, grant.hosts) and host not in _test_hosts():
                    raise Blocked(f"{host} isn't one of the sites this app was approved for")
                ip = await resolve_public(host, port)
                up_r, up_w = await asyncio.wait_for(asyncio.open_connection(ip, port), 15)
                writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                await writer.drain()
            else:
                u = urlsplit(target)
                if u.scheme != "http" or not u.hostname:
                    raise Blocked("only web requests can go out")
                if not host_allowed(u.hostname, grant.hosts) and u.hostname not in _test_hosts():
                    raise Blocked(f"{u.hostname} isn't one of the sites this app was approved for")
                port = u.port or 80
                ip = await resolve_public(u.hostname, port)
                up_r, up_w = await asyncio.wait_for(asyncio.open_connection(ip, port), 15)
                path = (u.path or "/") + (f"?{u.query}" if u.query else "")
                kept = [h for h in headers if h and not h.lower().startswith(("proxy-", "connection:", "keep-alive:"))]
                up_w.write(f"{method} {path} {version}\r\n".encode("latin-1")
                           + "\r\n".join(kept + ["Connection: close"]).encode("latin-1") + b"\r\n\r\n")
        except (Blocked, OSError, ValueError, TimeoutError, asyncio.TimeoutError) as exc:
            why = str(exc) if isinstance(exc, Blocked) else "the site couldn't be reached"
            if why not in grant.blocked:
                grant.blocked.append(why[:200])
                del grant.blocked[:-20]
            try:
                writer.write(self._refuse("403 Forbidden", why))
                await writer.drain()
            finally:
                writer.close()
            return
        await asyncio.gather(self._pipe(grant, reader, up_w), self._pipe(grant, up_r, writer), return_exceptions=True)

    @staticmethod
    async def _pipe(grant: Grant, r: asyncio.StreamReader, w: asyncio.StreamWriter) -> None:
        try:
            while True:
                chunk = await asyncio.wait_for(r.read(65536), IDLE_S)
                if not chunk:
                    break
                grant.bytes_used += len(chunk)
                if grant.bytes_used > MAX_BYTES:
                    break
                w.write(chunk)
                await w.drain()
        except (ConnectionError, TimeoutError, asyncio.TimeoutError, OSError):
            pass
        finally:
            try:
                w.close()
            except Exception:  # noqa: BLE001
                pass
