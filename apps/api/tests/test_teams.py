"""Teams and who works with whom (the mind map's People & projects view).

Owners make teams of the organisation's people; everyone in it can see them; strangers can't. A project
board can belong to a team. The collaboration view links people who share tasks on a project board,
hand work to each other, are named together in meetings and emails, or share a team; it narrows to one
project or one team (showing who from outside the team works with it); and it only uses what the
viewer can already see."""
from __future__ import annotations

import os
import uuid
from datetime import UTC, datetime

import asyncpg
import pytest

from conftest import ADMIN_DSN, join, make_actor
from kritvia_api.services import collab

pytestmark = pytest.mark.asyncio


async def _person(client, full_name: str):
    who = await make_actor(client, full_name.split()[0].lower())
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute("UPDATE users SET full_name = $1 WHERE id = $2", full_name, who.id)
    finally:
        await conn.close()
    return who


async def _setup(client):
    owner = await _person(client, "Meera Owner")
    org = (await owner.post("/orgs", json={"name": "Brightpath", "slug": f"bp-{uuid.uuid4().hex[:8]}"})).json()["id"]
    v = (await owner.post(f"/orgs/{org}/ventures", json={"name": "Brightpath", "slug": f"bp-{uuid.uuid4().hex[:6]}"})).json()["id"]
    alice = await _person(client, "Alice Rao")
    bob = await _person(client, "Bob Singh")
    viewer = await _person(client, "Vik Viewer")
    await join(owner, alice, org, v, "operator")
    await join(owner, bob, org, v, "operator")
    await join(owner, viewer, org, v, "viewer")
    return owner, alice, bob, viewer, org, v


async def _card(actor, v: str, board: str, title: str, assignee=None) -> str:
    b = (await actor.get(f"/ventures/{v}/boards/{board}")).json()
    c = await actor.post(f"/ventures/{v}/cards", json={"list_id": b["lists"][0]["id"], "title": title})
    assert c.status_code == 201, c.text
    if assignee:
        r = await actor.patch(f"/ventures/{v}/cards/{c.json()['id']}", json={"assignee_id": str(assignee)})
        assert r.status_code == 200, r.text
    return c.json()["id"]


async def _meeting(org: str, v: str, title: str, people: list[str], project: str | None, roles=None) -> None:
    """A meeting whose knowledge graph names these people (and a project), as extraction would."""
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        doc = await conn.fetchval(
            "INSERT INTO documents (org_id, venture_id, title, kind, sha256, status, access_roles)"
            " VALUES ($1, $2, $3, 'meeting', $4, 'ready', $5) RETURNING id",
            uuid.UUID(org), uuid.UUID(v), title, os.urandom(16).hex(), roles)
        chunk = await conn.fetchval(
            "INSERT INTO chunks (org_id, venture_id, document_id, ord, text_enc, char_count, access_roles)"
            " VALUES ($1, $2, $3, 0, $4, 10, $5) RETURNING id", uuid.UUID(org), uuid.UUID(v), doc, b"x", roles)
        ids = []
        for name, typ in [(p, "person") for p in people] + ([(project, "project")] if project else []):
            eid = await conn.fetchval("SELECT id FROM entities WHERE venture_id = $1 AND type = $2 AND canonical = $3",
                                      uuid.UUID(v), typ, name.lower())
            ids.append(eid or await conn.fetchval(
                "INSERT INTO entities (org_id, venture_id, type, name, canonical) VALUES ($1, $2, $3, $4, $5) RETURNING id",
                uuid.UUID(org), uuid.UUID(v), typ, name, name.lower()))
        for a in ids[1:]:
            await conn.execute(
                "INSERT INTO edges (org_id, venture_id, src_id, dst_id, type, source_chunk_id, access_roles)"
                " VALUES ($1, $2, $3, $4, 'DISCUSSED_WITH', $5, $6)", uuid.UUID(org), uuid.UUID(v), ids[0], a, chunk, roles)
    finally:
        await conn.close()


def _link(g, a, b, kind="works_with"):
    for x in g["links"]:
        if x["kind"] == kind and {x["source"], x["target"]} == {a, b}:
            return x
    return None


async def test_teams_are_owned_by_owners_and_seen_by_everyone_in_the_org(client):
    owner, alice, bob, viewer, org, v = await _setup(client)
    stranger = await _person(client, "Stan Stranger")
    r = await owner.post(f"/orgs/{org}/teams", json={
        "name": "  Platform  ", "color": "green", "description": "Core product",
        "members": [{"user_id": str(alice.id), "is_lead": True}, {"user_id": str(bob.id)}]})
    assert r.status_code == 201, r.text
    t = r.json()
    assert t["name"] == "Platform" and [m["full_name"] for m in t["members"]] == ["Alice Rao", "Bob Singh"]
    assert t["members"][0]["is_lead"] is True
    assert (await owner.post(f"/orgs/{org}/teams", json={"name": "platform"})).status_code == 409
    # only people in the organisation can join
    bad = await owner.post(f"/orgs/{org}/teams", json={"name": "Design", "members": [{"user_id": str(stranger.id)}]})
    assert bad.status_code == 409
    # members see it, can't change it; strangers see nothing
    seen = (await alice.get(f"/orgs/{org}/teams")).json()
    assert seen["can_edit"] is False and [x["name"] for x in seen["teams"]] == ["Platform"]
    assert {p["full_name"] for p in seen["people"]} >= {"Alice Rao", "Bob Singh", "Meera Owner", "Vik Viewer"}
    assert (await alice.post(f"/orgs/{org}/teams", json={"name": "Sales"})).status_code == 403
    assert (await alice.put(f"/orgs/{org}/teams/{t['id']}", json={"name": "Mine"})).status_code == 403
    assert (await stranger.get(f"/orgs/{org}/teams")).status_code == 404
    # edit: drop Bob, keep Alice as lead, rename
    r = await owner.put(f"/orgs/{org}/teams/{t['id']}", json={"name": "Platform team", "color": "aqua",
                                                              "members": [{"user_id": str(alice.id), "is_lead": True}]})
    assert r.status_code == 200 and [m["full_name"] for m in r.json()["members"]] == ["Alice Rao"]
    # a board in the team; another org's team is refused
    other_owner = await _person(client, "Other Owner")
    oorg = (await other_owner.post("/orgs", json={"name": "Other", "slug": f"ot-{uuid.uuid4().hex[:8]}"})).json()["id"]
    ot = (await other_owner.post(f"/orgs/{oorg}/teams", json={"name": "Theirs"})).json()
    b = (await owner.post(f"/ventures/{v}/boards", json={"name": "Brain v2"})).json()
    assert (await owner.patch(f"/ventures/{v}/boards/{b['id']}", json={"team_id": ot["id"]})).status_code == 404
    r = await owner.patch(f"/ventures/{v}/boards/{b['id']}", json={"team_id": t["id"]})
    assert r.status_code == 200 and r.json()["team_id"] == t["id"]
    assert [x["name"] for x in (await viewer.get(f"/ventures/{v}/teams")).json()] == ["Platform team"]
    # deleting the team keeps the board, without a team
    assert (await owner.delete(f"/orgs/{org}/teams/{t['id']}")).status_code == 204
    boards = {x["name"]: x for x in (await owner.get(f"/ventures/{v}/boards")).json()}
    assert boards["Brain v2"]["team_id"] is None


async def test_who_works_with_whom(client):
    owner, alice, bob, viewer, org, v = await _setup(client)
    carol = await _person(client, "Carol Das")
    await join(owner, carol, org, v, "operator")
    team = (await owner.post(f"/orgs/{org}/teams", json={
        "name": "Platform", "members": [{"user_id": str(alice.id), "is_lead": True}, {"user_id": str(bob.id)}]})).json()
    await owner.post(f"/orgs/{org}/teams", json={"name": "Sales", "members": [{"user_id": str(carol.id)}]})
    acme = (await owner.post(f"/ventures/{v}/boards", json={"name": "Acme rollout"})).json()
    await owner.patch(f"/ventures/{v}/boards/{acme['id']}", json={"team_id": team["id"]})
    # Alice and Bob both work on Acme; Meera hands a card to Alice; Carol works on Acme too (from Sales)
    await _card(alice, v, acme["id"], "API", alice.id)
    await _card(alice, v, acme["id"], "Docs", alice.id)
    await _card(bob, v, acme["id"], "UI", bob.id)
    await _card(owner, v, acme["id"], "Kick-off", alice.id)
    await _card(carol, v, acme["id"], "Pricing", carol.id)
    # the main board doesn't make people collaborators
    main = (await owner.get(f"/ventures/{v}/boards")).json()[0]
    await _card(bob, v, main["id"], "Expenses", bob.id)
    await _card(carol, v, main["id"], "Leads", carol.id)
    # a meeting naming Alice, Carol, an outside contact and the project; a restricted one only loan officers see
    await _meeting(org, v, "Acme weekly", ["Alice Rao", "Carol Das", "Ravi Kumar"], "Acme rollout")
    await _meeting(org, v, "Board pay review", ["Bob Singh", "Carol Das"], None, roles=["loan_officer"])

    g = (await viewer.get(f"/ventures/{v}/collab")).json()
    a, b, c, m = str(alice.id), str(bob.id), str(carol.id), str(owner.id)
    names = {p["id"]: p for p in g["people"]}
    assert names[a]["teams"] == [team["id"]] and names[a]["leads"] == [team["id"]]
    ab = _link(g, a, b)
    assert ab["shared_tasks"] == 1 and ab["same_team"] is True and ab["projects"] == [acme["id"]]
    assert _link(g, m, a)["handoffs"] == 1
    ac = _link(g, a, c)
    assert ac["meetings"] == 1 and ac["evidence"][0]["title"] == "Acme weekly" and ac["shared_tasks"] == 1
    assert _link(g, b, c)["meetings"] == 0          # the restricted meeting isn't visible to a viewer
    assert "c:ravi kumar" in names and names["c:ravi kumar"]["kind"] == "contact"
    assert _link(g, a, "p:" + acme["id"], "on_project")["shared_tasks"] == 3
    assert _link(g, a, "t:" + team["id"], "in_team")["is_lead"] is True
    assert {t["name"] for t in g["teams"]} == {"Platform", "Sales"}
    assert [x["name"] for x in g["boards"]] == ["Acme rollout"]

    # one project: its people, and only its evidence
    p = (await viewer.get(f"/ventures/{v}/collab", params={"project": acme["id"]})).json()
    assert {x["id"] for x in p["people"]} == {a, b, c, m, "c:ravi kumar"}
    assert [t["name"] for t in p["teams"]] == ["Platform"] and [x["name"] for x in p["projects"]] == ["Acme rollout"]
    # one team: its people, plus who works with it from outside
    t = (await viewer.get(f"/ventures/{v}/collab", params={"team": team["id"]})).json()
    tp = {x["id"]: x for x in t["people"]}
    assert tp[a]["outside"] is False and tp[c]["outside"] is True and tp[m]["outside"] is True
    core = {a, b}
    assert all(x["source"] in core or x["target"] in core or x["projects"]
               for x in t["links"] if x["kind"] == "works_with")
    # sources can be switched off
    only_tasks = (await viewer.get(f"/ventures/{v}/collab", params={"docs": "false", "teams": "false"})).json()
    assert _link(only_tasks, a, c)["meetings"] == 0 and not any(x["kind"] == "in_team" for x in only_tasks["links"])
    assert not any(x["kind"] == "contact" for x in only_tasks["people"])
    stranger = await _person(client, "Nosy Stranger")
    assert (await stranger.get(f"/ventures/{v}/collab")).status_code == 404


async def test_leaving_the_org_leaves_its_teams(client):
    owner, alice, bob, viewer, org, v = await _setup(client)
    t = (await owner.post(f"/orgs/{org}/teams", json={"name": "Ops", "members": [{"user_id": str(bob.id)}]})).json()
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        await conn.execute("DELETE FROM memberships WHERE org_id = $1 AND user_id = $2", uuid.UUID(org), bob.id)
        assert await conn.fetchval("SELECT count(*) FROM team_members WHERE team_id = $1", uuid.UUID(t["id"])) == 0
    finally:
        await conn.close()


async def test_builder_matching_and_limits():
    people = {"u1": {"full_name": "Priya Sharma", "email": "priya@x.in"}, "u2": {"full_name": "Rohit Jain", "email": "rj@x.in"},
              "u3": {"full_name": "Priyanka Mehta", "email": "pm@x.in"}}
    now = datetime.now(UTC)
    big = [{"document_id": "d2", "title": "All hands", "kind": "meeting", "created_at": now, "type": "person",
            "name": f"Guest {i}", "email": None} for i in range(20)]
    g = collab.build(
        people=people, teams=[], members=[], boards=[{"id": "b0", "name": "Tasks", "is_default": True, "team_id": None}],
        cards=[{"board_id": "b0", "assignee_id": "u1", "created_by": "u1", "open": 2, "done": 0},
               {"board_id": "b0", "assignee_id": "u2", "created_by": "u2", "open": 1, "done": 0}],
        mentions=[{"document_id": "d1", "title": "Standup", "kind": "email", "created_at": now, "type": "person",
                   "name": "Priya", "email": None},           # first name only one person has
                  {"document_id": "d1", "title": "Standup", "kind": "email", "created_at": now, "type": "person",
                   "name": "Someone", "email": "RJ@x.in"}]     # by email
        + big + [{"document_id": "d2", "title": "All hands", "kind": "meeting", "created_at": now, "type": "person",
                  "name": "Rohit Jain", "email": None}])
    pr = _link(g, "u1", "u2")
    assert pr["emails"] == 1 and pr["shared_tasks"] == 0      # the main board alone doesn't link them
    assert _link(g, "u2", "c:guest 1") is None                # 21 people in one meeting: no pairs from it
    assert collab.match_people(people)("Priy") is None
