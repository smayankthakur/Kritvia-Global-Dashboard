"""OAuth for connected apps, as the MCP authorization spec asks of a client (2025-06-18 to 2026-07-28):

  1. discover   the MCP server answers 401 with WWW-Authenticate: Bearer resource_metadata="…"; Kritvia reads the
                Protected Resource Metadata (RFC 9728; else /.well-known/oauth-protected-resource[/path]) for its
                authorization server, then that server's metadata (RFC 8414 / OpenID, tried in the spec's order;
                its `issuer` must match exactly). No PKCE S256 -> refuse.
  2. client     a Client ID Metadata Document when the server supports it (client_id = our https URL serving
                the document, /public/mcp-client.json), else Dynamic Client Registration (RFC 7591)
  3. authorize  response_type=code, PKCE S256, state, scope (the challenge's, else everything it supports),
                resource = the MCP server's canonical URL (RFC 8707); the person signs in at the app
  4. callback   state checked against a sign-in started by the same person within 15 minutes; `iss` checked
                (RFC 9207) when sent or promised; the code is exchanged with the verifier and the same resource
  5. use        Authorization: Bearer on every call; refreshed a minute before it expires (refresh tokens rotate)

Every address used (metadata, token, registration) must be https on the public internet. Tokens are stored
encrypted with the business's key (purpose 'mcp.oauth') and never shown.
"""
from __future__ import annotations

import base64
import hashlib
import re
import secrets
import time
from typing import Any
from urllib.parse import urlencode, urlparse, urlunparse

import httpx

from kritvia_api.config import get_settings
from kritvia_api.services.mcp import McpError, check_url

PURPOSE = "mcp.oauth"
transport: httpx.AsyncBaseTransport | None = None        # tests inject


def client_id_url() -> str:
    """Our Client ID Metadata Document's address (served by the API at /public/mcp-client.json)."""
    return f"{get_settings().public_web_url.rstrip('/')}/api/k/public/mcp-client.json"


def redirect_uri() -> str:
    return f"{get_settings().public_web_url.rstrip('/')}/api/oauth/mcp/callback"


def client_document() -> dict[str, Any]:
    return {"client_id": client_id_url(), "client_name": "Kritvia", "client_uri": get_settings().public_web_url,
            "redirect_uris": [redirect_uri()], "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"], "token_endpoint_auth_method": "none", "application_type": "web"}


def canonical(url: str) -> str:
    u = urlparse(url.strip())
    path = u.path.rstrip("/") if u.path not in ("", "/") else ""
    return urlunparse((u.scheme.lower(), (u.netloc or "").lower(), path, "", u.query, ""))


def _http() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=transport, timeout=15, follow_redirects=False)


async def _get_json(client: httpx.AsyncClient, url: str) -> dict | None:
    await check_url(url)
    try:
        r = await client.get(url, headers={"Accept": "application/json", "MCP-Protocol-Version": "2025-06-18"})
    except httpx.TransportError:
        return None
    if r.status_code != 200:
        return None
    try:
        data = r.json()
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def _challenge(header: str) -> dict[str, str]:
    return {m.group(1).lower(): m.group(2) for m in re.finditer(r'(\w+)="([^"]*)"', header or "")}


async def discover(server_url: str) -> dict[str, Any]:
    """Everything needed to start a sign-in with this MCP server's authorization server."""
    server_url = await check_url(server_url)
    async with _http() as client:
        try:
            r = await client.post(server_url, json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "Kritvia", "version": "1.0"}}},
                headers={"Accept": "application/json, text/event-stream", "Content-Type": "application/json"})
        except httpx.TransportError as exc:
            raise McpError(f"could not reach the app ({type(exc).__name__})") from None
        ch = _challenge(r.headers.get("www-authenticate", "")) if r.status_code in (401, 403) else {}
        u = urlparse(server_url)
        prm_urls = [ch["resource_metadata"]] if ch.get("resource_metadata") else []
        if u.path not in ("", "/"):
            prm_urls.append(f"{u.scheme}://{u.netloc}/.well-known/oauth-protected-resource{u.path.rstrip('/')}")
        prm_urls.append(f"{u.scheme}://{u.netloc}/.well-known/oauth-protected-resource")
        prm = None
        for p in prm_urls:
            prm = await _get_json(client, p)
            if prm and prm.get("authorization_servers"):
                break
        if not prm or not prm.get("authorization_servers"):
            raise McpError("this app doesn't offer sign-in (OAuth); connect it with a token instead")
        issuer = str(prm["authorization_servers"][0]).rstrip("/")
        iu = urlparse(issuer)
        base, path = f"{iu.scheme}://{iu.netloc}", iu.path.rstrip("/")
        tries = ([f"{base}/.well-known/oauth-authorization-server{path}", f"{base}/.well-known/openid-configuration{path}",
                  f"{base}{path}/.well-known/openid-configuration"] if path
                 else [f"{base}/.well-known/oauth-authorization-server", f"{base}/.well-known/openid-configuration"])
        meta = None
        for t in tries:
            meta = await _get_json(client, t)
            if meta and meta.get("authorization_endpoint"):
                break
        if not meta or not meta.get("authorization_endpoint") or not meta.get("token_endpoint"):
            raise McpError("the app's sign-in server couldn't be found")
        if str(meta.get("issuer", "")).rstrip("/") != issuer:
            raise McpError("the app's sign-in server didn't identify itself correctly; not signing in")
        if "S256" not in (meta.get("code_challenge_methods_supported") or []):
            raise McpError("the app's sign-in server doesn't support PKCE, which is required")
        for k in ("authorization_endpoint", "token_endpoint"):
            await check_url(meta[k])
        scope = ch.get("scope") or " ".join(prm.get("scopes_supported") or meta.get("scopes_supported") or [])
        return {"issuer": issuer, "authorization_endpoint": meta["authorization_endpoint"],
                "token_endpoint": meta["token_endpoint"], "registration_endpoint": meta.get("registration_endpoint"),
                "cimd": bool(meta.get("client_id_metadata_document_supported")),
                "iss_param": bool(meta.get("authorization_response_iss_parameter_supported")),
                "scope": scope[:500], "resource": canonical(str(prm.get("resource") or server_url))}


async def register(d: dict[str, Any]) -> dict[str, str]:
    """A client ID for this authorization server: our metadata document, else dynamic registration."""
    if d["cimd"]:
        return {"client_id": client_id_url()}
    if not d.get("registration_endpoint"):
        raise McpError("this app needs a client registered with it by hand; connect it with a token instead")
    await check_url(d["registration_endpoint"])
    doc = {k: v for k, v in client_document().items() if k != "client_id"}
    if d.get("scope"):
        doc["scope"] = d["scope"]
    async with _http() as client:
        try:
            r = await client.post(d["registration_endpoint"], json=doc)
        except httpx.TransportError:
            raise McpError("the app's sign-in server couldn't be reached") from None
    if r.status_code not in (200, 201):
        raise McpError(f"the app refused to register Kritvia (HTTP {r.status_code})")
    data = r.json()
    if not data.get("client_id"):
        raise McpError("the app didn't give Kritvia a client ID")
    return {"client_id": str(data["client_id"]), **({"client_secret": str(data["client_secret"])}
                                                     if data.get("client_secret") else {})}


def start(d: dict[str, Any], client: dict[str, str]) -> tuple[str, dict[str, Any]]:
    """The address to send the person to, and what to remember until they come back."""
    verifier = secrets.token_urlsafe(64)[:96]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    state = secrets.token_urlsafe(32)
    q = {"response_type": "code", "client_id": client["client_id"], "redirect_uri": redirect_uri(),
         "code_challenge": challenge, "code_challenge_method": "S256", "state": state, "resource": d["resource"]}
    if d.get("scope"):
        q["scope"] = d["scope"]
    sep = "&" if "?" in d["authorization_endpoint"] else "?"
    return f"{d['authorization_endpoint']}{sep}{urlencode(q)}", {**d, **client, "verifier": verifier, "state": state}


async def _token(saved: dict[str, Any], form: dict[str, str]) -> dict[str, Any]:
    await check_url(saved["token_endpoint"])
    form = {**form, "client_id": saved["client_id"], "resource": saved["resource"]}
    if saved.get("client_secret"):
        form["client_secret"] = saved["client_secret"]
    async with _http() as client:
        try:
            r = await client.post(saved["token_endpoint"], data=form, headers={"Accept": "application/json"})
        except httpx.TransportError:
            raise McpError("the app's sign-in server couldn't be reached") from None
    if r.status_code != 200:
        raise McpError(f"the app's sign-in server refused (HTTP {r.status_code})")
    tok = r.json()
    if not tok.get("access_token"):
        raise McpError("the app's sign-in server gave no access token")
    return {**{k: saved[k] for k in ("issuer", "token_endpoint", "client_id", "resource") if k in saved},
            **({"client_secret": saved["client_secret"]} if saved.get("client_secret") else {}),
            "access_token": tok["access_token"], "refresh_token": tok.get("refresh_token") or saved.get("refresh_token"),
            "expires_at": int(time.time()) + int(tok.get("expires_in") or 3600), "scope": tok.get("scope", "")}


async def exchange(saved: dict[str, Any], code: str, iss: str | None) -> dict[str, Any]:
    if iss is not None and iss.rstrip("/") != saved["issuer"]:
        raise McpError("the sign-in came back from the wrong server; not connected")
    if iss is None and saved.get("iss_param"):
        raise McpError("the sign-in came back without saying where from; not connected")
    return await _token(saved, {"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri(),
                                "code_verifier": saved["verifier"]})


def needs_refresh(tok: dict[str, Any]) -> bool:
    return int(tok.get("expires_at") or 0) - 60 < time.time()


async def refresh(tok: dict[str, Any]) -> dict[str, Any]:
    if not tok.get("refresh_token"):
        raise McpError("the app's sign-in has expired: sign in again in the App store")
    return await _token(tok, {"grant_type": "refresh_token", "refresh_token": tok["refresh_token"]})
