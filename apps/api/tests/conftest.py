"""Test harness: a fresh database per run, migrated as kritvia_owner, with the
API connecting as the restricted kritvia_app role — the same split as prod.
"""
from __future__ import annotations

import asyncio
import base64
import os
import subprocess
import uuid
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
import sys  # noqa: E402

sys.path.insert(0, str(REPO / "apps" / "worker"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
TEST_DB = os.environ.get("KRITVIA_TEST_DB", "kritvia_test")
PG_HOST = os.environ.get("PGHOST", "localhost")
os.environ.setdefault("PGPASSWORD", "postgres")

OWNER_DSN = f"postgresql://kritvia_owner:owner@{PG_HOST}/{TEST_DB}"
APP_DSN = f"postgresql+asyncpg://kritvia_app:app@{PG_HOST}/{TEST_DB}"
ADMIN_DSN = f"postgresql://postgres:{os.environ['PGPASSWORD']}@{PG_HOST}/{TEST_DB}"

os.environ["DATABASE_URL"] = APP_DSN
os.environ["MASTER_KEK_B64"] = base64.b64encode(os.urandom(32)).decode()
os.environ["JWT_SECRET"] = "test-secret-" + "x" * 40
os.environ["DISPATCH_MODE"] = "inline"
os.environ["MESSAGING_FALLBACK"] = "log"
os.environ["MAIL_TRANSPORT"] = "memory"
os.environ["AUTH_RATE_LIMIT_PER_MINUTE"] = "10000"
os.environ["CLIENT_IP_HEADER"] = "cf-connecting-ip"

subprocess.run(["bash", str(REPO / "infra/postgres/local-bootstrap.sh"), TEST_DB], check=True,
               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

from kritvia_api.db.migrate import migrate  # noqa: E402

asyncio.run(migrate(OWNER_DSN))

import httpx  # noqa: E402

from kritvia_api.main import app  # noqa: E402


from fakes import FakeLiteLLM  # noqa: E402

FAKE_LLM = FakeLiteLLM()


def _install_services():
    from kritvia_api.config import get_settings
    from kritvia_api.engine.bootstrap import build_services
    from kritvia_api.engine.context import set_services
    from kritvia_api.services.model_router import ModelRouter, TierConfig
    from kritvia_api.services.sandbox import LocalSandbox

    router = ModelRouter(TierConfig.load(get_settings().tiers_config_path), "http://litellm", "k",
                         transport=httpx.MockTransport(FAKE_LLM))
    svc = build_services(dispatch_mode="inline", router=router, sandbox=LocalSandbox("test"))
    set_services(svc)
    return svc


SERVICES = _install_services()


@pytest.fixture
def fake_llm():
    FAKE_LLM.rules.clear()
    FAKE_LLM.calls.clear()
    FAKE_LLM.fail.clear()
    yield FAKE_LLM
    FAKE_LLM.rules.clear()
    FAKE_LLM.fail.clear()


@pytest.fixture(scope="session")
def services():
    return SERVICES


@pytest.fixture(scope="session")
async def client():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        yield c


class Actor:
    def __init__(self, client: httpx.AsyncClient, email: str, token: str, user_id: uuid.UUID):
        self.c, self.email, self.token, self.id = client, email, token, user_id

    @property
    def h(self) -> dict:
        return {"Authorization": f"Bearer {self.token}"}

    async def get(self, url, **kw):
        return await self.c.get(url, headers=self.h, **kw)

    async def post(self, url, **kw):
        return await self.c.post(url, headers=self.h, **kw)

    async def patch(self, url, **kw):
        return await self.c.patch(url, headers=self.h, **kw)

    async def delete(self, url, **kw):
        return await self.c.delete(url, headers=self.h, **kw)

    async def put(self, url, **kw):
        return await self.c.put(url, headers=self.h, **kw)


async def join(owner: "Actor", who: "Actor", org: str, venture: str | None, role: str) -> None:
    """Invite + accept: how new people join an organisation."""
    r = await owner.post(f"/orgs/{org}/invitations", json={"email": who.email, "role": role, "venture_id": venture})
    assert r.status_code == 201, r.text
    a = await who.post("/invitations/accept", json={"token": r.json()["token"]})
    assert a.status_code == 200, a.text


async def make_actor(client, name: str) -> Actor:
    email = f"{name}-{uuid.uuid4().hex[:8]}@example.com"
    r = await client.post("/auth/register", json={"email": email, "full_name": name,
                                                  "password": "correct horse battery"})
    assert r.status_code == 201, r.text
    token = r.json()["access_token"]
    me = await client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
    return Actor(client, email, token, uuid.UUID(me.json()["id"]))


@pytest.fixture(scope="session")
async def world(client):
    """Mayank owns an org with two ventures. Alice operates Sitelytc only,
    Bob is Truhome's loan officer, Vera views Sitelytc, Mallory is outsider."""
    mayank = await make_actor(client, "mayank")
    alice = await make_actor(client, "alice")
    bob = await make_actor(client, "bob")
    vera = await make_actor(client, "vera")
    mallory = await make_actor(client, "mallory")

    slug = uuid.uuid4().hex[:8]
    org = (await mayank.post("/orgs", json={"name": "Sitelytc Group", "slug": f"sg-{slug}"})).json()["id"]
    site = (await mayank.post(f"/orgs/{org}/ventures", json={"name": "Sitelytc", "slug": "sitelytc"})).json()["id"]
    tru = (await mayank.post(f"/orgs/{org}/ventures", json={"name": "Truhome", "slug": "truhome"})).json()["id"]

    for who, venture, role in ((alice, site, "operator"), (bob, tru, "loan_officer"), (vera, site, "viewer")):
        await join(mayank, who, org, venture, role)

    m_org = (await mallory.post("/orgs", json={"name": "Other", "slug": f"other-{slug}"})).json()["id"]
    m_ven = (await mallory.post(f"/orgs/{m_org}/ventures", json={"name": "X", "slug": "xventure"})).json()["id"]

    a_lead = (await alice.post(f"/ventures/{site}/leads",
                               json={"name": "Acme Corp", "notes": "wants a Next.js rebuild, budget 3L"})).json()
    b_lead = (await bob.post(f"/ventures/{tru}/leads",
                             json={"name": "Sharma family", "notes": "home loan, PAN pending"})).json()
    return dict(mayank=mayank, alice=alice, bob=bob, vera=vera, mallory=mallory,
                org=org, site=site, tru=tru, m_org=m_org, m_ven=m_ven,
                a_lead=a_lead["id"], b_lead=b_lead["id"])
