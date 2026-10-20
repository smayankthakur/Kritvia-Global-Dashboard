"""The App store's list (app_catalog):

  kritvia    apps Kritvia checked work with the assistant (remote MCP servers run by the app's own company)
  registry   the official MCP Registry (registry.modelcontextprotocol.io, API v0.1), synced every hour by the
             worker: servers with a hosted address install directly; servers that are packages (npm, PyPI, a
             container image) can be asked for, and run once Kritvia's team approved that exact version
  github     projects people sent in from GitHub (pending until Kritvia's team approves them)
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

import httpx
from sqlalchemy import text

from kritvia_api.services.github_install import package_of

log = logging.getLogger(__name__)
transport: httpx.AsyncBaseTransport | None = None        # tests inject
PAGES = 60

# Remote MCP servers run by the app's own company (checked October 2026). auth_modes: the first is offered first.
KRITVIA_APPS: list[dict[str, Any]] = [
    {"id": "kritvia:notion", "title": "Notion", "url": "https://mcp.notion.com/mcp", "auth_modes": ["oauth"],
     "description": "Search, read and write pages and databases in your Notion workspace.",
     "docs_url": "https://developers.notion.com/docs/mcp"},
    {"id": "kritvia:linear", "title": "Linear", "url": "https://mcp.linear.app/mcp", "auth_modes": ["oauth", "bearer"],
     "description": "Find, create and update issues, projects and comments in Linear.",
     "docs_url": "https://linear.app/docs/mcp"},
    {"id": "kritvia:stripe", "title": "Stripe", "url": "https://mcp.stripe.com", "auth_modes": ["oauth", "bearer"],
     "description": "Customers, payments, invoices and payment links in your Stripe account.",
     "docs_url": "https://docs.stripe.com/mcp"},
    {"id": "kritvia:atlassian", "title": "Jira & Confluence", "url": "https://mcp.atlassian.com/v2/mcp",
     "auth_modes": ["oauth"], "description": "Jira issues and Confluence pages in your Atlassian site.",
     "docs_url": "https://support.atlassian.com/rovo/docs/getting-started-with-the-atlassian-remote-mcp-server/"},
    {"id": "kritvia:hubspot", "title": "HubSpot", "url": "https://mcp.hubspot.com", "auth_modes": ["oauth"],
     "description": "Contacts, companies, deals and tickets in your HubSpot CRM.",
     "docs_url": "https://developers.hubspot.com/mcp"},
    {"id": "kritvia:asana", "title": "Asana", "url": "https://mcp.asana.com/v2/mcp", "auth_modes": ["oauth"],
     "description": "Tasks, projects and comments in Asana.", "docs_url": "https://developers.asana.com/docs/using-asanas-mcp-server"},
    {"id": "kritvia:zapier", "title": "Zapier", "url": "https://mcp.zapier.com/api/v1/connect",
     "auth_modes": ["oauth", "bearer"], "description": "Thousands of apps through the actions you set up in Zapier.",
     "docs_url": "https://zapier.com/mcp"},
    {"id": "kritvia:intercom", "title": "Intercom", "url": "https://mcp.intercom.com/mcp", "auth_modes": ["oauth", "bearer"],
     "description": "Conversations and contacts in Intercom.", "docs_url": "https://developers.intercom.com/docs/guides/mcp"},
    {"id": "kritvia:cloudflare", "title": "Cloudflare", "url": "https://mcp.cloudflare.com/mcp", "auth_modes": ["oauth", "bearer"],
     "description": "Your Cloudflare account: DNS, Workers, analytics.", "docs_url": "https://developers.cloudflare.com/agents/model-context-protocol/"},
    {"id": "kritvia:huggingface", "title": "Hugging Face", "url": "https://huggingface.co/mcp",
     "auth_modes": ["none", "bearer", "oauth"], "description": "Search models, datasets, papers and Spaces.",
     "docs_url": "https://huggingface.co/settings/mcp"},
    {"id": "kritvia:apify", "title": "Apify", "url": "https://mcp.apify.com", "auth_modes": ["oauth", "bearer"],
     "description": "Ready-made web scrapers and automations (Actors).", "docs_url": "https://docs.apify.com/platform/integrations/mcp"},
    {"id": "kritvia:exa", "title": "Exa web search", "url": "https://mcp.exa.ai/mcp", "auth_modes": ["header", "none"],
     "header_name": "x-api-key", "description": "Search the web and read pages, built for AI.",
     "docs_url": "https://docs.exa.ai/reference/exa-mcp"},
    {"id": "kritvia:github", "title": "GitHub", "url": "https://api.githubcopilot.com/mcp/", "auth_modes": ["bearer"],
     "description": "Repositories, issues and pull requests (a personal access token).",
     "docs_url": "https://github.com/github/github-mcp-server"},
]


async def seed(conn) -> None:
    for a in KRITVIA_APPS:
        await conn.execute(text("SELECT private.catalog_upsert(CAST(:p AS jsonb))"),
                           {"p": json.dumps({"source": "kritvia", "kind": "mcp", "status": "listed", **a})})


def from_registry(entry: dict[str, Any]) -> dict[str, Any] | None:
    """One registry entry as a catalogue row (None when it can't be used: no https address, no package)."""
    s = entry.get("server") or {}
    name = str(s.get("name") or "")
    if not re.fullmatch(r"[A-Za-z0-9_.\-/]{3,180}", name):
        return None
    title = str(s.get("title") or name.rsplit("/", 1)[-1]).strip()[:120]
    base = {"id": f"registry:{name}", "source": "registry", "title": title,
            "description": str(s.get("description") or "")[:1000],
            "repo_url": str((s.get("repository") or {}).get("url") or "")[:500] or None,
            "docs_url": str(s.get("websiteUrl") or "")[:500] or None}
    for r in s.get("remotes") or []:
        url = str((r or {}).get("url") or "")
        if r.get("type") == "streamable-http" and url.startswith("https://") and "{" not in url and len(url) <= 500:
            secret_headers = [h for h in r.get("headers") or [] if isinstance(h, dict) and h.get("isSecret")]
            if any(str(h.get("name", "")).lower() == "authorization" for h in secret_headers):
                modes, header = ["bearer", "oauth"], None
            elif secret_headers:
                modes, header = ["header"], str(secret_headers[0].get("name"))[:60]
            else:
                modes, header = ["oauth", "bearer", "none"], None
            return {**base, "kind": "mcp", "url": url, "auth_modes": modes, "header_name": header}
    for p in s.get("packages") or []:
        if (isinstance(p, dict) and p.get("registryType") in ("npm", "pypi", "oci") and p.get("identifier")
                and (p.get("transport") or {}).get("type", "stdio") == "stdio"):
            pk = package_of(p)
            pk["version"] = str(p.get("version") or s.get("version") or "latest")[:60]
            return {**base, "kind": "hosted", "package": pk, "auth_modes": []}
    return None


async def sync_registry(max_pages: int = PAGES) -> dict[str, int]:
    """Worker, hourly: the official MCP Registry's latest versions into the catalogue."""
    from kritvia_api.config import get_settings
    from kritvia_api.db.session import tenant_tx
    base = get_settings().mcp_registry_url.rstrip("/")
    rows: list[dict[str, Any]] = []
    gone: list[str] = []
    cursor = None
    async with httpx.AsyncClient(transport=transport, timeout=30, follow_redirects=False,
                                 headers={"Accept": "application/json", "User-Agent": "Kritvia-App-Store"}) as client:
        for _ in range(max_pages):
            params: dict[str, Any] = {"limit": 100, "version": "latest"}
            if cursor:
                params["cursor"] = cursor
            r = await client.get(f"{base}/v0.1/servers", params=params)
            if r.status_code != 200:
                log.warning("MCP registry answered HTTP %s", r.status_code)
                break
            data = r.json()
            for e in data.get("servers") or []:
                meta = ((e.get("_meta") or {}).get("io.modelcontextprotocol.registry/official") or {})
                name = str((e.get("server") or {}).get("name") or "")
                if meta.get("status") == "deleted":
                    gone.append(f"registry:{name}")
                    continue
                row = from_registry(e)
                if row:
                    rows.append(row)
            cursor = (data.get("metadata") or {}).get("nextCursor")
            if not cursor:
                break
    async with tenant_tx(None, "system") as conn:
        await seed(conn)
        for row in rows:
            await conn.execute(text("SELECT private.catalog_upsert(CAST(:p AS jsonb))"), {"p": json.dumps(row)})
        dropped = (await conn.execute(text("SELECT private.catalog_drop(:g)"), {"g": gone})).scalar() if gone else 0
    return {"synced": len(rows), "dropped": int(dropped or 0)}


SEARCH_COLS = ("id, source, kind, title, description, url, auth_modes, header_name, docs_url, repo_url, package,"
               " egress_hosts, status")


async def search(conn, q: str | None, source: str | None, limit: int = 30) -> list[Any]:
    where, params = ["true"], {"l": min(max(limit, 1), 60)}
    if source:
        where.append("source = :s")
        params["s"] = source
    if q and q.strip():
        where.append("(to_tsvector('simple', title || ' ' || coalesce(description, '') || ' ' || id)"
                     " @@ plainto_tsquery('simple', :q) OR title ILIKE :like OR id ILIKE :like)")
        params["q"] = q.strip()[:100]
        params["like"] = "%" + q.strip()[:100].replace("%", "").replace("_", "\\_") + "%"
    return (await conn.execute(text(
        f"SELECT {SEARCH_COLS} FROM app_catalog WHERE {' AND '.join(where)}"
        " ORDER BY (source = 'kritvia') DESC, (status = 'approved') DESC, (kind = 'mcp') DESC, title LIMIT :l"),
        params)).all()
