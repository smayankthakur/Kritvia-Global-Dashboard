"""Slack for the team: a channel connected with its incoming-webhook address hears when a draft waits for
a yes or a chat needs a person, with a link back, and never what a customer wrote."""
from __future__ import annotations

import asyncio
import json
import uuid

import httpx
import pytest

from conftest import join, make_actor
from test_inbox_assistant import SUPPORT_MAIL, script_inbox

pytestmark = pytest.mark.asyncio

# Built from parts so the test never contains a whole webhook address (secret scanners flag those).
SLACK = "hooks.slack." + "com"
FAKE = "/".join(("T0ABCDEF1", "B0ABCDEF2", "a1B2c3D4e5F6g7H8i9J0k1L2"))
HOOK = f"https://{SLACK}/services/{FAKE}"


class FakeSlack:
    def __init__(self) -> None:
        self.posts: list[tuple[str, dict]] = []
        self.status, self.reply = 200, "ok"

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.posts.append((str(request.url), json.loads(request.content)))
        return httpx.Response(self.status, text=self.reply)


@pytest.fixture
def slack(services):
    from kritvia_api.services.slack import SlackClient
    fake = FakeSlack()
    old = services.slack
    services.slack = SlackClient(transport=httpx.MockTransport(fake))
    yield fake
    services.slack = old


@pytest.fixture(scope="module")
async def team(world, client):
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Slack Shop", "slug": f"slack-{uuid.uuid4().hex[:6]}"})).json()["id"]
    await mayank.put(f"/ventures/{v}/settings", json={"kind": "general", "business_name": "Mehta Stores", "city": "Pune"})
    assert (await mayank.put(f"/ventures/{v}/workflow-configs/inbox_assistant",
                             json={"enabled": True, "settings": {}, "instructions": ""})).status_code == 200
    operator = await make_actor(client, "slack-operator")
    await join(mayank, operator, world["org"], v, "operator")
    return {**world, "v": v, "operator": operator}


async def settle(fake: FakeSlack, n: int) -> None:
    for _ in range(100):
        if len(fake.posts) >= n:
            return
        await asyncio.sleep(0.02)


async def test_only_slack_webhook_addresses_are_accepted():
    from kritvia_api.services.slack import allowed_webhook
    assert allowed_webhook(HOOK)
    for bad in (f"http://{SLACK}/services/{FAKE}",
                f"https://{SLACK}.evil.in/services/{FAKE}",
                f"https://user@{SLACK}/services/{FAKE}",
                f"https://{SLACK}:8443/services/{FAKE}",
                f"https://{SLACK}/services/{FAKE}?x=1",
                f"https://{SLACK}/workflows/{FAKE}",
                f"https://127.0.0.1/services/{FAKE}"):
        assert not allowed_webhook(bad), bad


async def test_channel_hears_what_needs_a_person(team, fake_llm, slack):
    from kritvia_api.services import push
    mayank, operator, v = team["mayank"], team["operator"], team["v"]
    # only admins connect, only a Slack address, and only one Slack accepts
    assert (await operator.post(f"/ventures/{v}/connectors/slack", json={"webhook_url": HOOK})).status_code == 404
    bad = await mayank.post(f"/ventures/{v}/connectors/slack",
                            json={"webhook_url": "https://example.com/services/T0ABCDEF1/B0ABCDEF2/abcdefabcdefabcdef"})
    assert bad.status_code == 422 and "hooks.slack.com" in bad.json()["detail"]
    slack.status, slack.reply = 404, "no_service"
    gone = await mayank.post(f"/ventures/{v}/connectors/slack", json={"webhook_url": HOOK})
    assert gone.status_code == 422 and "no longer works" in gone.json()["detail"]
    slack.status, slack.reply = 200, "ok"
    r = await mayank.post(f"/ventures/{v}/connectors/slack", json={"webhook_url": HOOK, "channel": "#sales"})
    assert r.status_code == 201, r.text
    assert r.json()["channel"] == "#sales"
    hello = slack.posts[-1][1]
    assert slack.posts[-1][0] == HOOK and "Kritvia is connected" in hello["text"]
    conn = next(c for c in (await mayank.get(f"/ventures/{v}/connectors")).json() if c["provider"] == "slack")
    assert conn["account_email"] == "#sales" and HOOK not in json.dumps(conn)

    # a draft waiting for a yes: the channel hears who and gets a link, not the customer's words
    before = len(slack.posts)
    script_inbox(fake_llm)
    run = await mayank.post(f"/ventures/{v}/runs", json={"workflow": "inbox_assistant", "input": SUPPORT_MAIL})
    assert run.status_code == 201, run.text
    await settle(slack, before + 1)
    post = slack.posts[-1][1]
    assert post["text"].startswith("A draft needs your yes")
    button = post["blocks"][1]["elements"][0]
    assert "/inbox?id=" in button["url"] and "Mehta Stores" not in button["url"]
    assert SUPPORT_MAIL["body"] not in json.dumps(post) and "Pune" not in json.dumps(post)

    # news for the team (a chat that needs a person) goes there too, with &, < and > made safe
    before = len(slack.posts)
    await push.notify_venture(uuid.UUID(v), title="A customer wants a person", body="<Neha & co> on WhatsApp",
                              url=f"/v/{v}/whatsapp?c=1", tag="t")
    await settle(slack, before + 1)
    text = slack.posts[-1][1]["blocks"][0]["text"]["text"]
    assert "&lt;Neha &amp; co&gt;" in text and "<Neha" not in text

    # an address Slack says is gone marks the connector, and nothing fails
    slack.status, slack.reply = 404, "channel_is_archived"
    before = len(slack.posts)
    await push.notify_venture(uuid.UUID(v), title="Template approved", body="x", url="/", tag="t")
    await settle(slack, before + 1)
    for _ in range(50):
        conn = next(c for c in (await mayank.get(f"/ventures/{v}/connectors")).json() if c["provider"] == "slack")
        if conn["last_error"]:
            break
        await asyncio.sleep(0.02)
    assert "no longer works" in conn["last_error"]

    # disconnected: nothing more is posted
    slack.status, slack.reply = 200, "ok"
    assert (await mayank.delete(f"/ventures/{v}/connectors/{conn['id']}")).status_code == 204
    before = len(slack.posts)
    await push.notify_venture(uuid.UUID(v), title="A customer wants a person", body="Ravi", url="/", tag="t")
    await asyncio.sleep(0.2)
    assert len(slack.posts) == before
