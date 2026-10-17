"""Single sign-on (Enterprise): an owner sets up an OpenID Connect provider for a domain proved with
DNS; people with an account or an invitation sign in through it; a forged, foreign or replayed
sign-in fails; enforcement waits for an owner's own SSO sign-in and then closes the other ways in."""
from __future__ import annotations

import time
import uuid
from urllib.parse import parse_qs, urlparse

import asyncpg
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from conftest import ADMIN_DSN, Actor
from kritvia_api.config import get_settings

pytestmark = pytest.mark.asyncio
ISSUER = "https://idp.example.org/tenant"


class FakeIdP:
    def __init__(self) -> None:
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.txt: list[str] = []
        self.email = ""
        self.nonce = ""
        self.overrides: dict = {}
        self.sign_with = self.key
        self.codes: list[str] = []

    def jwks(self) -> dict:
        pub = jwt.algorithms.RSAAlgorithm.to_jwk(self.key.public_key(), as_dict=True)
        return {"keys": [{**pub, "kid": "k1", "use": "sig", "alg": "RS256"}]}

    async def get_json(self, url: str) -> dict:
        if url == ISSUER + "/.well-known/openid-configuration":
            return {"issuer": ISSUER, "authorization_endpoint": ISSUER + "/authorize",
                    "token_endpoint": ISSUER + "/token", "jwks_uri": ISSUER + "/keys"}
        if url == ISSUER + "/keys":
            return self.jwks()
        raise AssertionError(url)

    async def post_form(self, url: str, data: dict) -> tuple[int, dict]:
        assert url == ISSUER + "/token" and data["client_secret"] == "s3cret-value" and data["code_verifier"]
        self.codes.append(data["code"])
        now = int(time.time())
        claims = {"iss": ISSUER, "aud": "kritvia-client", "sub": "u-" + self.email, "iat": now, "exp": now + 300,
                  "email": self.email, "email_verified": True, "name": "SSO Person", "nonce": self.nonce, **self.overrides}
        return 200, {"id_token": jwt.encode(claims, self.sign_with, algorithm="RS256", headers={"kid": "k1"})}

    async def txt_records(self, name: str) -> list[str]:
        return list(self.txt)


async def _register(client, email: str) -> Actor:
    r = await client.post("/auth/register", json={"email": email, "full_name": "x", "password": "correct horse battery"})
    assert r.status_code == 201, r.text
    token = r.json()["access_token"]
    me = await client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
    return Actor(client, email, token, uuid.UUID(me.json()["id"]))


async def _plan(org: str, plan: str) -> None:
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute("INSERT INTO org_plans (org_id, plan) VALUES ($1, $2) ON CONFLICT (org_id) DO UPDATE SET plan = $2",
                           uuid.UUID(org), plan)
    finally:
        await conn.close()


async def _signin(client, idp: FakeIdP, email: str, nonce: str | None = None):
    nonce = nonce or uuid.uuid4().hex + uuid.uuid4().hex
    r = await client.post("/auth/sso/start", json={"email": email, "nonce": nonce})
    if r.status_code != 200:
        return r
    q = parse_qs(urlparse(r.json()["url"]).query)
    assert q["code_challenge_method"] == ["S256"] and q["redirect_uri"][0].endswith("/api/oauth/sso/callback")
    idp.email, idp.nonce = email, q["nonce"][0]
    return await client.post("/auth/sso/complete", json={"code": "c-" + uuid.uuid4().hex, "state": q["state"][0], "nonce": nonce})


async def test_sso(client, monkeypatch):
    from kritvia_api.services import sso
    idp = FakeIdP()
    for f in ("get_json", "post_form", "txt_records"):
        monkeypatch.setattr(sso, f, getattr(idp, f))
    monkeypatch.setattr(get_settings(), "default_plan", "free")
    domain = f"acme{uuid.uuid4().hex[:8]}.in"
    owner = await _register(client, f"owner@{domain}")
    org = (await owner.post("/orgs", json={"name": "Acme", "slug": f"acme-{uuid.uuid4().hex[:8]}"})).json()["id"]
    v = (await owner.post(f"/orgs/{org}/ventures", json={"name": "Acme", "slug": f"a-{uuid.uuid4().hex[:6]}"})).json()["id"]
    body = {"domain": domain, "issuer": ISSUER + "/", "client_id": "kritvia-client", "client_secret": "s3cret-value"}

    got = (await owner.get(f"/orgs/{org}/sso")).json()
    assert got["available"] is False and got["configured"] is False
    assert (await owner.put(f"/orgs/{org}/sso", json=body)).status_code == 402
    await _plan(org, "enterprise")
    assert (await owner.put(f"/orgs/{org}/sso", json={**body, "enforce": True})).status_code == 409
    r = await owner.put(f"/orgs/{org}/sso", json=body)
    assert r.status_code == 200, r.text
    cfg = r.json()
    assert cfg["issuer"] == ISSUER and cfg["verified"] is False and cfg["txt_name"] == f"_kritvia-sso.{domain}"
    assert "client_secret" not in cfg and "secret" not in str(cfg).lower().replace("client_id", "")

    # not proved yet: no SSO for the domain
    assert (await _signin(client, idp, f"owner@{domain}")).status_code == 404
    assert (await owner.post(f"/orgs/{org}/sso/verify")).status_code == 409
    idp.txt = ["v=spf1 -all", cfg["txt_value"]]
    assert (await owner.post(f"/orgs/{org}/sso/verify")).json()["verified"] is True

    # someone with no account and no invitation is refused; an invited person is let in
    assert (await _signin(client, idp, f"stranger@{domain}")).status_code == 403
    inv = await owner.post(f"/orgs/{org}/invitations", json={"email": f"new@{domain}", "role": "operator", "venture_id": v})
    assert inv.status_code == 201
    r = await _signin(client, idp, f"new@{domain}")
    assert r.status_code == 200, r.text and r.json()["access_token"]

    # forged signature, wrong audience, another domain, a nonce from another browser
    idp.sign_with = idp.other
    assert (await _signin(client, idp, f"owner@{domain}")).status_code == 403
    idp.sign_with = idp.key
    idp.overrides = {"aud": "someone-else"}
    assert (await _signin(client, idp, f"owner@{domain}")).status_code == 403
    idp.overrides = {"email": "owner@evil.example"}
    assert (await _signin(client, idp, f"owner@{domain}")).status_code == 403
    idp.overrides = {}
    nonce = uuid.uuid4().hex * 2
    start = await client.post("/auth/sso/start", json={"email": f"owner@{domain}", "nonce": nonce})
    state = parse_qs(urlparse(start.json()["url"]).query)["state"][0]
    assert (await client.post("/auth/sso/complete", json={"code": "c", "state": state, "nonce": "f" * 64})).status_code == 400

    # enforcement needs an owner's own SSO sign-in first; then the other ways in close for that domain
    assert (await owner.put(f"/orgs/{org}/sso", json={**body, "client_secret": None, "enforce": True})).status_code == 409
    r = await _signin(client, idp, f"owner@{domain}")
    assert r.status_code == 200
    # the account had never proved its address, so SSO claimed it: earlier sessions and the password end
    owner = Actor(client, owner.email, r.json()["access_token"], owner.id)
    r = await owner.put(f"/orgs/{org}/sso", json={**body, "client_secret": None, "enforce": True})
    assert r.status_code == 200 and r.json()["enforce"] is True and r.json()["owner_tested"] is True
    pw = await client.post("/auth/login", json={"email": f"owner@{domain}", "password": "correct horse battery"})
    assert pw.status_code == 403 and "single sign-on" in pw.json()["detail"]
    assert (await client.post("/auth/email/start", json={"email": f"owner@{domain}"})).status_code == 403
    assert (await client.post("/auth/login", json={"email": owner.email.replace(domain, "example.com"),
                                                   "password": "x" * 12})).status_code == 401   # other domains unaffected
    assert (await _signin(client, idp, f"owner@{domain}")).status_code == 200

    # a plan without SSO: SSO and its enforcement both stop, so nobody is locked out
    await _plan(org, "scale")
    assert (await _signin(client, idp, f"owner@{domain}")).status_code == 404
    # (the gate is gone: the answer is the ordinary one; SSO had already removed the unproved password)
    assert (await client.post("/auth/login", json={"email": f"owner@{domain}", "password": "correct horse battery"})).status_code == 401
    await _plan(org, "enterprise")

    # changing the provider asks for a fresh owner test and turns nothing else off
    r = await owner.put(f"/orgs/{org}/sso", json={**body, "client_id": "kritvia-client", "client_secret": "s3cret-value", "enforce": True})
    assert r.status_code == 409

    # another organisation can't claim the domain; a non-owner sees nothing
    other = await _register(client, f"o-{uuid.uuid4().hex[:6]}@example.com")
    o2 = (await other.post("/orgs", json={"name": "Other", "slug": f"o-{uuid.uuid4().hex[:8]}"})).json()["id"]
    await _plan(o2, "enterprise")
    assert (await other.put(f"/orgs/{o2}/sso", json=body)).status_code == 409
    assert (await other.get(f"/orgs/{org}/sso")).status_code == 404
    assert (await owner.delete(f"/orgs/{org}/sso")).status_code == 204
    assert (await _signin(client, idp, f"owner@{domain}")).status_code == 404
