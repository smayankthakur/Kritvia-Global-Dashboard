"""Any web app with an API: a business gives the address of the app's OpenAPI (or Swagger) description and
its operations become tools the assistant can use, like a connected MCP app.

  fetch(url)            the description (JSON or YAML, at most 2 MB, https on the public internet)
  parse(doc, url)       -> {title, base_url, operations: [...]}: at most 40 operations, reads (GET) first
  tools(spec, server)   the operations as assistant tools; GET operations are reads, every other one is a
                        "send" that a person always approves first
  call(spec, op, args)  one operation: path and query parameters filled in, the rest sent as the JSON body

The app's token is sent the way the business chose (bearer, its own header, or basic) and is never shown.
Every call is checked again: https, public addresses only, no redirects, 20 seconds, 1 MB.
"""
from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import quote, urljoin, urlparse

import httpx
import yaml

from kritvia_api.services.mcp import MAX_TOOLS, AppTool, McpError, check_url, http_client

MAX_SPEC = 2_000_000
MAX_BYTES = 1_000_000
METHODS = ("get", "post", "put", "patch", "delete")
transport: httpx.AsyncBaseTransport | None = None        # tests inject


def _http(timeout: float = 20) -> httpx.AsyncClient:
    return http_client(timeout, transport)


async def fetch(url: str) -> dict[str, Any]:
    url = await check_url(url)
    async with _http() as client:
        try:
            r = await client.get(url, headers={"Accept": "application/json, application/yaml, text/yaml, */*"})
        except httpx.TransportError as exc:
            raise McpError(f"could not reach the app ({type(exc).__name__})") from None
    if r.status_code != 200:
        raise McpError(f"the API description answered HTTP {r.status_code}")
    if len(r.content) > MAX_SPEC:
        raise McpError("the API description is too large (2 MB at most)")
    try:
        doc = json.loads(r.text)
    except ValueError:
        try:
            doc = yaml.safe_load(r.text)
        except yaml.YAMLError:
            raise McpError("that isn't an OpenAPI description (JSON or YAML)") from None
    if not isinstance(doc, dict) or not (doc.get("openapi") or doc.get("swagger")) or not isinstance(doc.get("paths"), dict):
        raise McpError("that isn't an OpenAPI description (no 'openapi' and 'paths')")
    return doc


def _ref(doc: dict[str, Any], node: Any, depth: int = 0) -> Any:
    """Follows a local $ref (#/components/... or #/definitions/...), a few levels deep."""
    while isinstance(node, dict) and isinstance(node.get("$ref"), str) and depth < 5:
        ref = node["$ref"]
        if not ref.startswith("#/"):
            return {}
        cur: Any = doc
        for part in ref[2:].split("/"):
            cur = cur.get(part.replace("~1", "/").replace("~0", "~"), {}) if isinstance(cur, dict) else {}
        node, depth = cur, depth + 1
    return node if isinstance(node, dict) else {}


def _name(op: dict[str, Any], method: str, path: str, taken: set[str]) -> str:
    raw = str(op.get("operationId") or f"{method}_{path}")
    name = re.sub(r"[^A-Za-z0-9_]+", "_", raw).strip("_")[:60] or method
    base, n = name, 2
    while name in taken:
        name = f"{base[:56]}_{n}"
        n += 1
    taken.add(name)
    return name


def _base_url(doc: dict[str, Any], spec_url: str, override: str | None) -> str:
    if override:
        return override.rstrip("/")
    if doc.get("swagger"):
        host = doc.get("host") or urlparse(spec_url).netloc
        return f"https://{host}{doc.get('basePath') or ''}".rstrip("/")
    servers = doc.get("servers") or []
    raw = str((servers[0] or {}).get("url") or "") if servers and isinstance(servers[0], dict) else ""
    if "{" in raw:
        raw = re.sub(r"\{[^}]*\}", "", raw)
    return urljoin(spec_url, raw or "/").rstrip("/")


def parse(doc: dict[str, Any], spec_url: str, base_url: str | None = None) -> dict[str, Any]:
    base = _base_url(doc, spec_url, base_url)
    if not base.startswith("https://"):
        raise McpError("the API's address must be https (give its base address)")
    ops: list[dict[str, Any]] = []
    taken: set[str] = set()
    for path, item in (doc.get("paths") or {}).items():
        if not isinstance(item, dict) or not str(path).startswith("/"):
            continue
        shared = [_ref(doc, p) for p in item.get("parameters") or []]
        for method in METHODS:
            op = item.get(method)
            if not isinstance(op, dict) or op.get("deprecated"):
                continue
            params = {}
            for p in shared + [_ref(doc, p) for p in op.get("parameters") or []]:
                where, pname = p.get("in"), str(p.get("name") or "")
                if where in ("path", "query") and re.fullmatch(r"[A-Za-z0-9_.\-\[\]]{1,60}", pname):
                    params[pname] = {"in": where, "required": bool(p.get("required") or where == "path"),
                                     "description": str(p.get("description") or (p.get("schema") or {}).get("type")
                                                        or p.get("type") or "")[:120]}
            body: dict[str, dict[str, Any]] = {}
            has_body = False
            if method != "get":
                rb = _ref(doc, op.get("requestBody"))
                schema = _ref(doc, ((rb.get("content") or {}).get("application/json") or {}).get("schema"))
                if not schema:      # Swagger 2: an "in: body" parameter
                    for p in op.get("parameters") or []:
                        p = _ref(doc, p)
                        if p.get("in") == "body":
                            schema = _ref(doc, p.get("schema"))
                has_body = bool(schema) or bool(rb)
                req = set(schema.get("required") or [])
                for k, v in list((schema.get("properties") or {}).items())[:15]:
                    if re.fullmatch(r"[A-Za-z0-9_\-]{1,40}", str(k)) and k not in params:
                        v = _ref(doc, v)
                        body[str(k)] = {"required": k in req,
                                        "description": str(v.get("description") or v.get("type") or "")[:120]}
            desc = str(op.get("summary") or op.get("description") or f"{method.upper()} {path}")
            ops.append({"name": _name(op, method, str(path), taken), "method": method.upper(), "path": str(path)[:300],
                        "description": f"{desc[:240]} ({method.upper()} {path})"[:300], "params": params,
                        "body": body, "has_body": has_body and not body, "read_only": method == "get"})
    if not ops:
        raise McpError("the API description has no operations")
    ops.sort(key=lambda o: not o["read_only"])            # reads first, then the rest, in the API's order
    title = str((doc.get("info") or {}).get("title") or urlparse(base).netloc)[:120]
    return {"title": title, "base_url": base, "spec_url": spec_url, "operations": ops[:MAX_TOOLS],
            "total": len(ops)}


def tools(spec: dict[str, Any], server: str) -> list[AppTool]:
    out = []
    for op in spec.get("operations") or []:
        fields = {k: v["description"] or k for k, v in {**op["params"], **op["body"]}.items()}
        required = tuple(k for k, v in {**op["params"], **op["body"]}.items() if v.get("required"))
        if op.get("has_body"):
            fields["body"] = "the JSON body to send"
        out.append(AppTool(server=server, name=op["name"], description=op["description"], read_only=op["read_only"],
                           fields=dict(list(fields.items())[:16]), required=required))
    return out


async def call(spec: dict[str, Any], name: str, args: dict[str, Any], headers: dict[str, str]) -> str:
    op = next((o for o in spec.get("operations") or [] if o["name"] == name), None)
    if op is None:
        raise McpError(f"the app has no operation {name!r}")
    path = op["path"]
    query: dict[str, str] = {}
    for k, p in op["params"].items():
        if k not in args or args[k] in (None, ""):
            if p["required"]:
                raise McpError(f"{name} needs {k!r}")
            continue
        v = args[k]
        if p["in"] == "path":
            path = path.replace("{" + k + "}", quote(str(v), safe=""))
        else:
            query[k] = v if isinstance(v, str) else json.dumps(v) if isinstance(v, (dict, list)) else str(v)
    if "{" in path:
        raise McpError(f"{name} is missing a value for its address")
    body: Any = None
    if op["body"]:
        body = {k: args[k] for k in op["body"] if k in args}
    elif op.get("has_body") and "body" in args:
        body = args["body"]
        if isinstance(body, str):
            try:
                body = json.loads(body)
            except ValueError:
                pass
    url = await check_url(spec["base_url"] + path)
    async with _http() as client:
        try:
            r = await client.request(op["method"], url, params=query or None,
                                     json=body if op["method"] != "GET" and body is not None else None,
                                     headers={"Accept": "application/json", **headers})
        except httpx.TransportError as exc:
            raise McpError(f"could not reach the app ({type(exc).__name__})") from None
    if len(r.content) > MAX_BYTES:
        raise McpError("the app's answer was too large")
    if r.status_code in (401, 403):
        raise McpError("the app refused the token (check it in the App store)")
    if r.status_code >= 400:
        raise McpError(f"the app answered HTTP {r.status_code}: {r.text[:200]}")
    return (r.text or f"HTTP {r.status_code}")[:20000]
