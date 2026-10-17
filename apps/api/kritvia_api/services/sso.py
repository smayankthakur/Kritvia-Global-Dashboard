"""Single sign-on (Enterprise) with an organisation's own identity provider over OpenID Connect.

  set up   an owner saves the email domain, the provider's issuer URL, a client ID and secret;
           proves the domain with a DNS TXT record  _kritvia-sso.<domain>  =  kritvia-sso=<token>
  start    someone types an email on that domain -> the provider's sign-in page (authorization
           code flow with PKCE S256, state and nonce bound to this browser's httpOnly cookie)
  finish   the code is exchanged at the provider's token endpoint; the id_token's signature
           (provider JWKS), issuer, audience, expiry and nonce are checked, and the email must be on
           the organisation's domain -> signed in (existing account or pending invitation only)

Network calls go through `get_json`, `post_form` and `txt_records`, which tests replace. Every
provider address must be https and resolve to public internet addresses.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import uuid
from typing import Any
from urllib.parse import urlencode

import httpx
import jwt

from kritvia_api.config import get_settings

ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "ES256", "ES384"]
TXT_PREFIX = "_kritvia-sso"
MAX_BYTES = 512_000


class SsoError(Exception):
    pass


def secret_context(org_id: uuid.UUID) -> bytes:
    return f"kritvia-sso|{org_id}".encode()


def new_verify_token() -> str:
    return secrets.token_hex(16)


def txt_name(domain: str) -> str:
    return f"{TXT_PREFIX}.{domain}"


def txt_value(token: str) -> str:
    return f"kritvia-sso={token}"


def redirect_uri() -> str:
    return get_settings().public_web_url.rstrip("/") + "/api/oauth/sso/callback"


def domain_of(email: str) -> str:
    return email.rsplit("@", 1)[-1].strip().lower() if "@" in email else ""


def nonce_hash(nonce: str) -> str:
    return hashlib.sha256(("sso-signin|" + nonce).encode()).hexdigest()


def code_verifier(nonce: str) -> str:
    """PKCE verifier derived from the browser's cookie nonce, so it never travels in a URL."""
    key = get_settings().jwt_secret.encode()
    return base64.urlsafe_b64encode(hmac.new(key, f"sso-pkce|{nonce}".encode(), hashlib.sha256).digest()).rstrip(b"=").decode()


def code_challenge(verifier: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()


# ---------------------------------------------------------------------------- network --
async def _checked(url: str) -> str:
    from kritvia_api.services.mcp import McpError, check_url
    try:
        return await check_url(url)
    except McpError as exc:
        raise SsoError(str(exc)) from None


async def get_json(url: str) -> dict[str, Any]:
    url = await _checked(url)
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=False) as c:
            r = await c.get(url, headers={"Accept": "application/json"})
    except httpx.HTTPError as exc:
        raise SsoError(f"could not reach the identity provider ({type(exc).__name__})") from None
    if r.status_code != 200 or len(r.content) > MAX_BYTES:
        raise SsoError(f"the identity provider answered HTTP {r.status_code}")
    try:
        return r.json()
    except ValueError:
        raise SsoError("the identity provider's answer was not JSON") from None


async def post_form(url: str, data: dict[str, str]) -> tuple[int, dict[str, Any]]:
    url = await _checked(url)
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=False) as c:
            r = await c.post(url, data=data, headers={"Accept": "application/json"})
    except httpx.HTTPError as exc:
        raise SsoError(f"could not reach the identity provider ({type(exc).__name__})") from None
    try:
        body = r.json() if len(r.content) <= MAX_BYTES else {}
    except ValueError:
        body = {}
    return r.status_code, body if isinstance(body, dict) else {}


async def txt_records(name: str) -> list[str]:
    """TXT records for a name, over DNS-over-HTTPS (Cloudflare, then Google)."""
    for url in ("https://cloudflare-dns.com/dns-query", "https://dns.google/resolve"):
        try:
            async with httpx.AsyncClient(timeout=8) as c:
                r = await c.get(url, params={"name": name, "type": "TXT"}, headers={"Accept": "application/dns-json"})
            if r.status_code != 200:
                continue
            return [str(a.get("data", "")).strip('"').replace('" "', "") for a in r.json().get("Answer", []) or []
                    if a.get("type") == 16]
        except (httpx.HTTPError, ValueError):
            continue
    raise SsoError("couldn't look up the DNS record right now, try again shortly")


# --------------------------------------------------------------------------- protocol --
def normal_issuer(issuer: str) -> str:
    return issuer.strip().rstrip("/")


async def discover(issuer: str) -> dict[str, Any]:
    issuer = normal_issuer(issuer)
    if not issuer.startswith("https://"):
        raise SsoError("the issuer must start with https://")
    meta = await get_json(issuer + "/.well-known/openid-configuration")
    if normal_issuer(str(meta.get("issuer", ""))) != issuer:
        raise SsoError("the provider's discovery document names a different issuer")
    for k in ("authorization_endpoint", "token_endpoint", "jwks_uri"):
        if not str(meta.get(k, "")).startswith("https://"):
            raise SsoError(f"the provider's discovery document has no https {k}")
    return meta


async def signin_url(issuer: str, client_id: str, state: str, nonce: str) -> str:
    meta = await discover(issuer)
    q = {"response_type": "code", "client_id": client_id, "redirect_uri": redirect_uri(),
         "scope": "openid email profile", "state": state, "nonce": nonce_hash(nonce),
         "code_challenge": code_challenge(code_verifier(nonce)), "code_challenge_method": "S256"}
    sep = "&" if "?" in meta["authorization_endpoint"] else "?"
    return meta["authorization_endpoint"] + sep + urlencode(q)


async def identity(issuer: str, client_id: str, client_secret: str, code: str, nonce: str, domain: str) -> dict[str, str]:
    """Exchange the code and check the id_token. Returns {email, name}."""
    issuer = normal_issuer(issuer)
    meta = await discover(issuer)
    status, tok = await post_form(meta["token_endpoint"], {
        "grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri(),
        "client_id": client_id, "client_secret": client_secret, "code_verifier": code_verifier(nonce)})
    if status != 200 or not tok.get("id_token"):
        raise SsoError(f"the identity provider refused the sign-in (HTTP {status}"
                       + (f", {str(tok.get('error'))[:60]}" if tok.get("error") else "") + ")")
    jwks = await get_json(meta["jwks_uri"])
    try:
        header = jwt.get_unverified_header(tok["id_token"])
        if header.get("alg") not in ALGORITHMS:
            raise SsoError("the identity provider signed the sign-in with an algorithm Kritvia doesn't accept")
        keys = jwt.PyJWKSet.from_dict(jwks).keys
        kid = header.get("kid")
        key = next((k for k in keys if kid and k.key_id == kid), None) or (keys[0] if len(keys) == 1 and not kid else None)
        if key is None:
            raise SsoError("the identity provider's signing key wasn't found")
        claims = jwt.decode(tok["id_token"], key=key.key, algorithms=ALGORITHMS, audience=client_id,
                            options={"require": ["exp", "iat", "iss", "aud", "sub"]}, leeway=60)
    except jwt.PyJWTError as exc:
        raise SsoError(f"the sign-in from the identity provider didn't check out ({type(exc).__name__})") from None
    if normal_issuer(str(claims.get("iss", ""))) != issuer:
        raise SsoError("the sign-in came from a different issuer")
    if not hmac.compare_digest(str(claims.get("nonce", "")), nonce_hash(nonce)):
        raise SsoError("this sign-in was not started in this browser")
    if isinstance(claims.get("aud"), list) and len(claims["aud"]) > 1 and claims.get("azp") != client_id:
        raise SsoError("the sign-in was meant for another app")
    email = str(claims.get("email") or "")
    if not email and "@" in str(claims.get("preferred_username") or ""):
        email = str(claims["preferred_username"])   # Microsoft Entra ID without the email claim
    email = email.strip().lower()
    if not email or domain_of(email) != domain:
        raise SsoError(f"the identity provider signed in an address that isn't on {domain}")
    if issuer == "https://accounts.google.com" and str(claims.get("hd") or "").lower() != domain:
        # a personal Google account can carry a work address; only the Workspace's own accounts have `hd`
        raise SsoError(f"sign in with your {domain} Google Workspace account")
    if claims.get("email_verified") is False:
        raise SsoError("the identity provider says this email address isn't verified")
    name = str(claims.get("name") or " ".join(x for x in (claims.get("given_name"), claims.get("family_name")) if x) or "")
    return {"email": email, "name": name[:120]}


async def required(db, email: str) -> bool:
    """True when the email's domain must sign in through SSO (enforced, proved, on a plan with SSO)."""
    from sqlalchemy import text

    from kritvia_api.plans import plan as plan_of
    d = domain_of(email)
    if not d:
        return False
    r = (await db.execute(text("SELECT enforce, plan FROM sso_for_domain(:d)"), {"d": d})).first()
    return bool(r and r.enforce and "sso" in plan_of(r.plan or None).extras)
