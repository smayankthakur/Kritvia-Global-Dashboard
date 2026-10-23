"""Outbound requests to addresses a customer typed (connected apps, OpenAPI apps, OAuth and SSO discovery):
only to the public internet, checked where the connection is made.

`public_ip` is the same rule as services/browser/guard.py and services/mcp-runner/guard.py: an IPv4-mapped
IPv6 address (::ffff:a.b.c.d) and a NAT64 address (64:ff9b::/96) are judged by the IPv4 address inside them,
so neither can reach the cloud metadata service, loopback or a private network.

`GuardedBackend` resolves the host itself when the TCP connection opens, refuses it unless every address
is public, and connects to that checked address. TLS still uses the host name (SNI and certificate checks
come from the URL, not from the address), and because the check happens at the connection there is no
window for a DNS answer to change between a check and the connection (DNS rebinding).
"""
from __future__ import annotations

import asyncio
import ipaddress
from collections.abc import Awaitable, Callable, Iterable
from typing import Any

import httpcore
import httpx

NAT64 = ipaddress.ip_network("64:ff9b::/96")
Resolver = Callable[[str], Awaitable[list[str]]]


def public_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """True only for an address on the public internet."""
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    if isinstance(ip, ipaddress.IPv6Address) and ip in NAT64:
        return public_ip(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF))
    return (ip.is_global and not ip.is_multicast and not ip.is_reserved and not ip.is_loopback
            and not ip.is_link_local and not ip.is_unspecified and not ip.is_private)


def all_public(addrs: Iterable[str]) -> bool:
    found = False
    for a in addrs:
        found = True
        try:
            ip = ipaddress.ip_address(a.split("%")[0])
        except ValueError:
            return False
        if not public_ip(ip):
            return False
    return found


class BlockedAddress(httpcore.ConnectError):
    pass


class GuardedBackend(httpcore.AsyncNetworkBackend):
    """Opens TCP connections only to checked public addresses."""

    def __init__(self, resolver: Resolver, inner: httpcore.AsyncNetworkBackend | None = None) -> None:
        self.resolver = resolver
        self.inner = inner or httpcore.AnyIOBackend()

    async def connect_tcp(self, host: str, port: int, timeout: float | None = None,
                          local_address: str | None = None,
                          socket_options: Iterable[Any] | None = None) -> httpcore.AsyncNetworkStream:
        try:
            literal = ipaddress.ip_address(host.strip("[]"))
            addrs = [str(literal)]
        except ValueError:
            try:
                addrs = await asyncio.wait_for(self.resolver(host), timeout or 10)
            except (OSError, TimeoutError) as exc:
                raise httpcore.ConnectError(f"{host} could not be found") from exc
        if not all_public(addrs):
            raise BlockedAddress("that address points inside a private network, which isn't allowed")
        last: Exception | None = None
        for a in sorted(addrs, key=lambda x: ":" in x):     # IPv4 first; each one is already checked
            try:
                return await self.inner.connect_tcp(a, port, timeout=timeout, local_address=local_address,
                                                    socket_options=socket_options)
            except (httpcore.ConnectError, httpcore.ConnectTimeout, OSError) as exc:
                last = exc
        raise httpcore.ConnectError(f"could not connect to {host}") from last

    async def connect_unix_socket(self, path: str, timeout: float | None = None,
                                  socket_options: Iterable[Any] | None = None) -> httpcore.AsyncNetworkStream:
        raise BlockedAddress("unix sockets aren't allowed")

    async def sleep(self, seconds: float) -> None:
        await self.inner.sleep(seconds)


def guarded_transport(resolver: Resolver) -> httpx.AsyncHTTPTransport:
    """An httpx transport whose connections go only to public addresses (see GuardedBackend). No proxy
    from the environment is used, so the check is what decides where the connection goes."""
    t = httpx.AsyncHTTPTransport(trust_env=False)
    t._pool._network_backend = GuardedBackend(resolver)     # httpcore exposes no public setter
    return t
