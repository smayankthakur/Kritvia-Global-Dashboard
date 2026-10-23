"""Find a business's contact email on its own website, so the Prospector can email it by itself.

Reads the home page and, if needed, a contact or about page linked from it (at most 3 pages, small and
quick), and picks the address that best looks like the business's own: on the site's own domain first,
then a common mail provider. Only public pages; never a login, a form or anything behind a cookie wall.
Private and internal addresses are refused (the URL comes from Google, not from us): each hop is checked
by its text first, and the connection itself goes only to a public address checked when it opens
(services/netguard.py), so a DNS answer can't change in between, and NAT64/IPv4-mapped forms of private
addresses are judged by the IPv4 address inside them.

Only the email address is kept. The website address itself comes from Google Maps and isn't stored.
"""
from __future__ import annotations

import asyncio
import re
import socket
from html import unescape
from urllib.parse import urljoin, urlparse

import httpx

from kritvia_api.services import netguard

PAGE_BYTES = 400_000
TIMEOUT = 6.0
MAX_PAGES = 3
UA = "Mozilla/5.0 (compatible; KritviaProspector/1.0; +https://sitelytc.com)"
EMAIL = re.compile(r"[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,190}\.[A-Za-z]{2,24}")
MAILTO = re.compile(r"mailto:([^\"'?>\s]+)", re.I)
LINK = re.compile(r"<a\b[^>]*href=[\"']([^\"'#]+)[\"'][^>]*>(.*?)</a>", re.I | re.S)
CONTACT_WORDS = re.compile(r"contact|reach|enquir|inquir|about|support|sampark|सम्पर्क|संपर्क", re.I)
FREE_MAIL = {"gmail.com", "yahoo.com", "yahoo.co.in", "outlook.com", "hotmail.com", "rediffmail.com",
             "live.com", "icloud.com", "zoho.com", "zohomail.in", "protonmail.com", "proton.me"}
# Addresses that are never the business: platforms, trackers, placeholders, image names.
JUNK_DOMAINS = re.compile(r"(example\.|sentry|wixpress|wix\.com|godaddy|squarespace|shopify|wordpress|"
                          r"domain\.com|email\.com|yourdomain|company\.com|sitelytc|cloudflare|googleapis|"
                          r"schema\.org|w3\.org)", re.I)
JUNK_LOCAL = re.compile(r"^(noreply|no-reply|donotreply|do-not-reply|abuse|postmaster|privacy|webmaster|"
                        r"root|admin@wordpress|user|username|name|email|test)$", re.I)
IMAGE_TAIL = re.compile(r"\.(png|jpe?g|gif|webp|svg|css|js)$", re.I)

_transport: httpx.AsyncBaseTransport | None = None   # tests


async def resolve(host: str) -> list[str]:
    infos = await asyncio.get_running_loop().getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    return sorted({i[4][0] for i in infos})


async def public(url: str) -> bool:
    u = urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname or u.username or u.password:
        return False
    if u.port not in (None, 80, 443):
        return False
    try:
        addrs = await resolve(u.hostname)
    except OSError:
        return False
    return netguard.all_public(addrs)


async def _resolve_now(host: str) -> list[str]:
    return await resolve(host)      # looked up when called, so a test's resolve() applies


def site_domain(url: str) -> str:
    host = (urlparse(url).hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


def candidates(html: str) -> list[str]:
    text = unescape(html)
    found = [m.group(1) for m in MAILTO.finditer(text)] + EMAIL.findall(re.sub(r"<[^>]+>", " ", text))
    out: list[str] = []
    for e in found:
        e = e.strip().strip(".,;:").lower()
        local, _, dom = e.partition("@")
        if not local or not dom or IMAGE_TAIL.search(e) or JUNK_DOMAINS.search(dom) or JUNK_LOCAL.match(local):
            continue
        if not EMAIL.fullmatch(e) or e in out:
            continue
        out.append(e)
    return out


def best(emails: list[str], domain: str) -> str | None:
    """The site's own domain beats a free mail address; a role address (info@, contact@) beats a person's."""
    def score(e: str) -> tuple[int, int]:
        local, dom = e.split("@", 1)
        own = 0 if (dom == domain or domain.endswith("." + dom) or dom.endswith("." + domain)) else (
            1 if dom in FREE_MAIL else 2)
        role = 0 if re.match(r"(info|contact|hello|enquir|inquir|sales|office|mail|support|booking)", local) else 1
        return own, role
    ranked = sorted(emails, key=score)
    return ranked[0] if ranked and score(ranked[0])[0] < 2 else None


async def find(website: str | None) -> str | None:
    """The business's contact email from its own website, or None. Never raises."""
    if not website:
        return None
    url = website if re.match(r"https?://", website, re.I) else "https://" + website
    domain = site_domain(url)
    seen: set[str] = set()
    found: list[str] = []
    queue = [url]
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=False,
                                     transport=_transport or netguard.guarded_transport(_resolve_now),
                                     headers={"User-Agent": UA, "Accept": "text/html"}) as http:
            while queue and len(seen) < MAX_PAGES:
                page = queue.pop(0)
                if page in seen:
                    continue
                seen.add(page)
                html = await _get(http, page)
                if html is None:
                    continue
                found += [e for e in candidates(html) if e not in found]
                if best(found, domain):
                    break
                if len(seen) == 1:      # from the home page: its contact / about pages, on the same site
                    for href, label in LINK.findall(html):
                        nxt = urljoin(page, href)
                        if site_domain(nxt) == domain and CONTACT_WORDS.search(href + " " + label):
                            queue.append(nxt)
    except Exception:  # noqa: BLE001 - a website that misbehaves just has no email for us
        return best(found, domain)
    return best(found, domain)


async def _get(http: httpx.AsyncClient, url: str, hops: int = 3) -> str | None:
    """A public HTML page, at most PAGE_BYTES of it; redirects are followed by hand so each hop is checked."""
    for _ in range(hops + 1):
        if not await public(url):
            return None
        async with http.stream("GET", url) as r:
            if r.is_redirect and r.headers.get("location"):
                url = urljoin(url, r.headers["location"])
                continue
            if r.status_code != 200 or "html" not in r.headers.get("content-type", "html"):
                return None
            body = b""
            async for chunk in r.aiter_bytes():
                body += chunk
                if len(body) >= PAGE_BYTES:
                    break
            return body[:PAGE_BYTES].decode(r.encoding or "utf-8", errors="replace")
    return None
