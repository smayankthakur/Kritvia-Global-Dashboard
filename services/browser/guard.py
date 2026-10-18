"""Network guard for the browser: every connection Chromium makes goes through EgressProxy.

The proxy resolves each host name ONCE, refuses it unless every address is public (no loopback,
private, link-local such as the cloud metadata address 169.254.169.254, carrier-grade NAT, multicast or
reserved ranges, IPv4-mapped IPv6 included), allows only ports 80 and 443, and then connects to the
address it checked. So a page can't reach the server's own services or the internal Docker network,
and DNS rebinding (a name that resolves to a public address first and a private one later) doesn't
help, because Chromium never resolves names itself.

Also counted per session: bytes through the proxy (MAX_BYTES), and the hosts refused (shown to the agent).
"""
from __future__ import annotations

import asyncio
import ipaddress
import os
import socket
from dataclasses import dataclass, field
from urllib.parse import urlsplit

ALLOWED_PORTS = {80, 443}
MAX_BYTES = 150 * 1024 * 1024        # per session, both directions
HEAD_LIMIT = 32 * 1024
IDLE_S = 60


class Blocked(Exception):
    pass


def _test_hosts() -> set[str]:
    # Only for this service's own tests (a local test server). Never set in production.
    return {h.strip() for h in os.environ.get("BROWSER_ALLOW_HOSTS_FOR_TESTS", "").split(",") if h.strip()}


def public_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    if isinstance(ip, ipaddress.IPv6Address) and ip in ipaddress.ip_network("64:ff9b::/96"):
        return public_ip(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF))
    return ip.is_global and not ip.is_multicast and not ip.is_reserved and not ip.is_loopback


def check_url(url: str) -> str:
    """A URL the agent may open: http(s), no user:password@, a normal port, not an IP literal that is
    private. Returns the URL. (Names are checked again when the proxy resolves them.)"""
    try:
        u = urlsplit(url.strip())
        port = u.port
    except ValueError:
        raise Blocked("that isn't a valid web address") from None
    if u.scheme not in ("http", "https"):
        raise Blocked("only http and https pages can be opened")
    if u.username or u.password:
        raise Blocked("web addresses with a user name or password aren't opened")
    host = (u.hostname or "").lower()
    if not host:
        raise Blocked("that web address has no site in it")
    if host in _test_hosts():
        return url.strip()
    if port is not None and port not in ALLOWED_PORTS:
        raise Blocked("only the normal web ports (80 and 443) can be used")
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal", ".lan", ".home.arpa")):
        raise Blocked("addresses on this server or a private network can't be opened")
    try:
        ip = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        ip = None
    if ip is not None and not public_ip(ip):
        raise Blocked("addresses on this server or a private network can't be opened")
    if "." not in host and ip is None:
        raise Blocked("that isn't a public web address")
    return url.strip()


async def resolve_public(host: str, port: int) -> str:
    """The address to connect to: refused unless EVERY address the name has is public."""
    host = host.strip("[]").lower()
    if host in _test_hosts():
        return host
    if port not in ALLOWED_PORTS:
        raise Blocked(f"port {port} isn't allowed")
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal", ".lan", ".home.arpa")):
        raise Blocked(f"{host} is private")
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
class EgressProxy:
    """An HTTP proxy on 127.0.0.1 for one browser session (CONNECT for https, absolute-URI for http)."""
    bytes_used: int = 0
    blocked: list[str] = field(default_factory=list)
    _server: asyncio.AbstractServer | None = None
    port: int = 0

    async def start(self) -> int:
        self._server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]
        return self.port

    async def close(self) -> None:
        if self._server is not None:
            self._server.close()
            try:
                await asyncio.wait_for(self._server.wait_closed(), 2)
            except (TimeoutError, asyncio.TimeoutError):
                pass

    def _refuse(self, why: str) -> bytes:
        if why not in self.blocked:
            self.blocked.append(why[:200])
            del self.blocked[:-20]
        body = f"Blocked by the Kritvia browser guard: {why}".encode()
        return (b"HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: "
                + str(len(body)).encode() + b"\r\n\r\n" + body)

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), IDLE_S)
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
        try:
            if self.bytes_used > MAX_BYTES:
                raise Blocked("this session has used its data allowance")
            if method.upper() == "CONNECT":
                host, _, p = target.rpartition(":")
                port = int(p) if p.isdigit() else 443
                ip = await resolve_public(host, port)
                up_r, up_w = await asyncio.wait_for(asyncio.open_connection(ip, port), 15)
                writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                await writer.drain()
            else:
                u = urlsplit(target)
                if u.scheme != "http" or not u.hostname:
                    raise Blocked("only web pages can be fetched")
                port = u.port or 80
                ip = await resolve_public(u.hostname, port)
                up_r, up_w = await asyncio.wait_for(asyncio.open_connection(ip, port), 15)
                path = (u.path or "/") + (f"?{u.query}" if u.query else "")
                kept = [h for h in headers if h and not h.lower().startswith(("proxy-", "connection:", "keep-alive:"))]
                up_w.write(f"{method} {path} {version}\r\n".encode("latin-1")
                           + "\r\n".join(kept + ["Connection: close"]).encode("latin-1") + b"\r\n\r\n")
        except (Blocked, OSError, ValueError, TimeoutError, asyncio.TimeoutError) as exc:
            why = str(exc) if isinstance(exc, Blocked) else "the site couldn't be reached"
            try:
                writer.write(self._refuse(why))
                await writer.drain()
            finally:
                writer.close()
            return
        await asyncio.gather(self._pipe(reader, up_w), self._pipe(up_r, writer), return_exceptions=True)

    async def _pipe(self, r: asyncio.StreamReader, w: asyncio.StreamWriter) -> None:
        try:
            while True:
                chunk = await asyncio.wait_for(r.read(65536), IDLE_S)
                if not chunk:
                    break
                self.bytes_used += len(chunk)
                if self.bytes_used > MAX_BYTES:
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
