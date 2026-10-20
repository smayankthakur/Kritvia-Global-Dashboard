"""Install from GitHub: a person pastes a link to a public GitHub project and Kritvia works out what it is.

  skills      the project has SKILL.md files (Agent Skills): each one can become a Kritvia skill, read as
              plain-words instructions (no code from the project runs). The person sees each one first.
  remote      its server.json names a hosted MCP address: it installs like any app by its address.
  hosted      it is an MCP server published to npm, PyPI or as a container image: it is sent to Kritvia's
              team, who review that exact version and the internet sites it may reach. Once approved, every
              business can install it; it runs in the sandboxed MCP runner (gVisor, its own container, no
              access to Kritvia's network, only the sites approved). Code that isn't published is never built.

Only GitHub's public API and raw files are read (no token), with small size limits.
"""
from __future__ import annotations

import json
import re
from typing import Any

import httpx
import yaml

from kritvia_api.services.mcp import McpError

API = "https://api.github.com"
RAW = "https://raw.githubusercontent.com"
MAX_FILE = 64_000
MAX_SKILLS = 20
REPO_RE = re.compile(r"^https://github\.com/([A-Za-z0-9_.\-]{1,100})/([A-Za-z0-9_.\-]{1,100})(?:\.git)?(?:/tree/([^/?#]+)(?:/([^?#]*))?)?/?(?:[?#].*)?$")
transport: httpx.AsyncBaseTransport | None = None        # tests inject


def parse_url(url: str) -> tuple[str, str, str | None, str]:
    m = REPO_RE.match(url.strip())
    if not m:
        raise McpError("paste a link like https://github.com/owner/project")
    owner, repo, branch, sub = m.group(1), m.group(2), m.group(3), (m.group(4) or "").strip("/")
    return owner, repo.removesuffix(".git"), branch, sub


def _http() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=transport, timeout=15, follow_redirects=True, max_redirects=3,
                             headers={"User-Agent": "Kritvia-App-Store", "Accept": "application/vnd.github+json"})


async def _json(client: httpx.AsyncClient, url: str) -> Any:
    try:
        r = await client.get(url)
    except httpx.TransportError:
        raise McpError("GitHub couldn't be reached; try again in a minute") from None
    if r.status_code == 404:
        return None
    if r.status_code in (403, 429):
        raise McpError("GitHub is limiting requests right now; try again in a few minutes")
    if r.status_code != 200 or len(r.content) > 5_000_000:
        raise McpError(f"GitHub answered HTTP {r.status_code}")
    return r.json()


async def _raw(client: httpx.AsyncClient, owner: str, repo: str, ref: str, path: str) -> str | None:
    try:
        r = await client.get(f"{RAW}/{owner}/{repo}/{ref}/{path}")
    except httpx.TransportError:
        return None
    if r.status_code != 200 or len(r.content) > MAX_FILE:
        return None
    return r.text


def front_matter(md: str) -> tuple[dict[str, Any], str]:
    if md.startswith("---"):
        end = md.find("\n---", 3)
        if end > 0:
            try:
                meta = yaml.safe_load(md[3:end]) or {}
            except yaml.YAMLError:
                meta = {}
            return (meta if isinstance(meta, dict) else {}), md[end + 4:].lstrip("\n")
    return {}, md


def as_skill(md: str, path: str) -> dict[str, str]:
    """A SKILL.md as a Kritvia skill: name, and instructions in plain words (at most 2000 characters)."""
    meta, body = front_matter(md)
    folder = path.rsplit("/", 2)[-2] if "/" in path else "skill"
    name = str(meta.get("name") or folder).replace("-", " ").replace("_", " ").strip()[:80] or "Imported skill"
    desc = str(meta.get("description") or "").strip()
    text = (f"{desc}\n\n" if desc else "") + body.strip()
    if len(text) > 2000:
        text = text[:1960].rsplit("\n", 1)[0] + "\n\n(shortened from the original)"
    return {"path": path, "name": name[:1].upper() + name[1:], "description": desc[:300], "instructions": text}


def _from_server_json(sj: dict[str, Any]) -> tuple[str | None, dict[str, Any] | None]:
    remote = next((r.get("url") for r in sj.get("remotes") or []
                   if isinstance(r, dict) and r.get("type") == "streamable-http" and "{" not in str(r.get("url", ""))), None)
    pkg = next((p for p in sj.get("packages") or [] if isinstance(p, dict)
                and p.get("registryType") in ("npm", "pypi", "oci") and p.get("identifier")
                and (p.get("transport") or {}).get("type", "stdio") == "stdio"), None)
    return remote, (package_of(pkg) if pkg else None)


def package_of(p: dict[str, Any]) -> dict[str, Any]:
    env = []
    for e in (p.get("environmentVariables") or [])[:20]:
        if isinstance(e, dict) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", str(e.get("name", ""))):
            env.append({"name": e["name"], "secret": bool(e.get("isSecret")), "required": bool(e.get("isRequired")),
                        "description": str(e.get("description") or "")[:200]})
    return {"registryType": p["registryType"], "identifier": str(p["identifier"])[:200],
            "version": str(p.get("version") or "latest")[:60], "env": env}


async def _published(client: httpx.AsyncClient, kind: str, name: str) -> str | None:
    """The latest published version on npm or PyPI, or None."""
    if kind == "npm":
        d = await _json(client, f"https://registry.npmjs.org/{name.replace('/', '%2F')}")
        return ((d or {}).get("dist-tags") or {}).get("latest")
    d = await _json(client, f"https://pypi.org/pypi/{name}/json")
    return ((d or {}).get("info") or {}).get("version")


async def analyse(url: str) -> dict[str, Any]:
    owner, repo, branch, sub = parse_url(url)
    async with _http() as client:
        info = await _json(client, f"{API}/repos/{owner}/{repo}")
        if not info:
            raise McpError("that GitHub project wasn't found (it must be public)")
        ref = branch or info.get("default_branch") or "main"
        tree = await _json(client, f"{API}/repos/{owner}/{repo}/git/trees/{ref}?recursive=1") or {}
        paths = [t["path"] for t in tree.get("tree") or [] if t.get("type") == "blob"]
        if sub:
            paths = [p for p in paths if p == sub or p.startswith(sub + "/")]
        out: dict[str, Any] = {
            "repo": f"{owner}/{repo}", "repo_url": f"https://github.com/{owner}/{repo}", "ref": ref,
            "title": str(info.get("name") or repo)[:120], "description": str(info.get("description") or "")[:1000],
            "stars": int(info.get("stargazers_count") or 0), "archived": bool(info.get("archived")),
            "license": ((info.get("license") or {}).get("spdx_id") or None), "skills": [], "remote": None,
            "package": None, "kind": "none"}
        for p in [p for p in paths if p.rsplit("/", 1)[-1] == "SKILL.md"][:MAX_SKILLS]:
            md = await _raw(client, owner, repo, ref, p)
            if md:
                out["skills"].append(as_skill(md, p))
        root = sub + "/" if sub else ""
        sj_text = await _raw(client, owner, repo, ref, f"{root}server.json") if f"{root}server.json" in paths else None
        if sj_text:
            try:
                out["remote"], out["package"] = _from_server_json(json.loads(sj_text))
            except ValueError:
                pass
        if not out["remote"] and not out["package"]:
            if f"{root}package.json" in paths:
                try:
                    pj = json.loads(await _raw(client, owner, repo, ref, f"{root}package.json") or "{}")
                except ValueError:
                    pj = {}
                deps = {**(pj.get("dependencies") or {}), **(pj.get("devDependencies") or {})}
                if pj.get("name") and ("@modelcontextprotocol/sdk" in deps or "mcp" in (pj.get("keywords") or [])):
                    v = await _published(client, "npm", pj["name"])
                    if v:
                        out["package"] = {"registryType": "npm", "identifier": pj["name"], "version": v, "env": []}
                    else:
                        out["unpublished"] = "npm"
            if not out["package"] and f"{root}pyproject.toml" in paths:
                py = await _raw(client, owner, repo, ref, f"{root}pyproject.toml") or ""
                m = re.search(r'^\s*name\s*=\s*"([A-Za-z0-9_.\-]+)"', py, re.M)
                if m and re.search(r'["\']mcp(\[[a-z,]+\])?\s*([<>=~!].*)?["\']', py):
                    v = await _published(client, "pypi", m.group(1))
                    if v:
                        out["package"] = {"registryType": "pypi", "identifier": m.group(1), "version": v, "env": []}
                    else:
                        out["unpublished"] = "PyPI"
    if out["remote"]:
        out["kind"] = "remote"
    elif out["package"]:
        out["kind"] = "hosted"
    elif out["skills"]:
        out["kind"] = "skills"
    return out


def catalog_id(repo: str) -> str:
    return f"github:{repo.lower()}"
