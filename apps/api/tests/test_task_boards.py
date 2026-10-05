"""Task boards: extracted tasks land on the default board as cards; moving a card to Done marks
the task done (and back); cards move between lists and boards; manual cards are encrypted at rest;
viewers read but can't change; role-restricted tasks stay hidden."""
from __future__ import annotations

import io
import uuid

import asyncpg
import pytest

from conftest import ADMIN_DSN, FAKE_LLM, join, make_actor

pytestmark = pytest.mark.asyncio


@pytest.fixture(scope="module")
async def ops(world, client):
    fake_llm = FAKE_LLM
    fake_llm.rules.clear()
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Ops", "slug": f"ops-{uuid.uuid4().hex[:6]}"})).json()["id"]
    viewer = await make_actor(client, "ops-viewer")
    await join(mayank, viewer, world["org"], v, "viewer")
    fake_llm.transcript = {
        "text": "Ravi will call the supplier. Priya sends the invoice.", "language": "en",
        "segments": [{"start": 0.0, "end": 4.0, "text": "Ravi will call the supplier."},
                     {"start": 70.0, "end": 76.0, "text": "Priya sends the invoice."}]}
    fake_llm.on("meeting transcript", {
        "entities": [], "edges": [],
        "facts": [{"statement": "Call the supplier", "kind": "task", "owner": "Ravi", "source": 0},
                  {"statement": "Send the invoice", "kind": "task", "owner": "Priya", "due_date": "2026-10-09",
                   "source": 1}]})
    files = {"file": ("ops.webm", io.BytesIO(b"\x1aE\xdf\xa3fake-audio"), "audio/webm")}
    r = await mayank.post(f"/ventures/{v}/meetings", files=files, data={"title": "Ops sync"})
    assert r.status_code == 202, r.text
    fake_llm.rules.clear()
    return {**world, "ops": v, "viewer": viewer}


def _cards(board: dict) -> dict[str, dict]:
    return {c["title"]: {**c, "list": lst["name"]} for lst in board["lists"] for c in lst["cards"]}


async def test_extracted_tasks_land_on_the_default_board(ops):
    mayank, v = ops["mayank"], ops["ops"]
    boards = (await mayank.get(f"/ventures/{v}/boards")).json()
    assert [b["name"] for b in boards] == ["Tasks"] and boards[0]["is_default"] and boards[0]["cards"] == 2
    board = (await mayank.get(f"/ventures/{v}/boards/{boards[0]['id']}")).json()
    assert [lst["name"] for lst in board["lists"]] == ["To do", "In progress", "Review", "Done"]
    assert board["lists"][-1]["is_done"] and board["can_edit"]
    cards = _cards(board)
    inv = cards["Send the invoice"]
    assert inv["list"] == "To do" and inv["due_date"] == "2026-10-09"
    assert inv["source"]["document_title"].endswith("Ops sync") and inv["source"]["source_start_s"] == 70.0
    assert inv["source"]["owner"] == "Priya"


async def test_moving_to_done_marks_the_task_done_and_back(ops):
    mayank, v = ops["mayank"], ops["ops"]
    bid = (await mayank.get(f"/ventures/{v}/boards")).json()[0]["id"]
    board = (await mayank.get(f"/ventures/{v}/boards/{bid}")).json()
    done = board["lists"][-1]["id"]
    card = _cards(board)["Call the supplier"]
    m = await mayank.post(f"/ventures/{v}/cards/{card['id']}/move", json={"list_id": done})
    assert m.status_code == 200, m.text
    assert m.json()["list_id"] == done and m.json()["done_at"]
    task = next(t for t in (await mayank.get(f"/ventures/{v}/facts?kind=task")).json() if t["statement"] == "Call the supplier")
    assert task["status"] == "done"
    # reopened elsewhere → the card goes back to the first open list
    await mayank.patch(f"/ventures/{v}/facts/{task['id']}", json={"status": "open"})
    board = (await mayank.get(f"/ventures/{v}/boards/{bid}")).json()
    c = _cards(board)["Call the supplier"]
    assert c["list"] == "To do" and c["done_at"] is None
    # archiving the card drops the task; it disappears from the board but not from the archive
    await mayank.patch(f"/ventures/{v}/cards/{c['id']}", json={"archived": True})
    task = next(t for t in (await mayank.get(f"/ventures/{v}/facts?kind=task")).json() if t["statement"] == "Call the supplier")
    assert task["status"] == "dropped"
    assert "Call the supplier" not in _cards((await mayank.get(f"/ventures/{v}/boards/{bid}")).json())
    assert "Call the supplier" in _cards((await mayank.get(f"/ventures/{v}/boards/{bid}?archived=true")).json())


async def test_manual_cards_details_and_moves_between_boards(ops):
    mayank, v, viewer = ops["mayank"], ops["ops"], ops["viewer"]
    nb = await mayank.post(f"/ventures/{v}/boards", json={"name": "Marketing"})
    assert nb.status_code == 201, nb.text
    mk = (await mayank.get(f"/ventures/{v}/boards/{nb.json()['id']}")).json()
    assert len(mk["lists"]) == 4 and not mk["is_default"]
    todo = mk["lists"][0]["id"]
    c = await mayank.post(f"/ventures/{v}/cards", json={"list_id": todo, "title": "Diwali offer poster"})
    assert c.status_code == 201, c.text
    cid = c.json()["id"]
    people = (await mayank.get(f"/ventures/{v}/people")).json()
    assert {p["email"] for p in people} >= {mayank.email, viewer.email}
    p = await mayank.patch(f"/ventures/{v}/cards/{cid}", json={
        "description": "A4 + Instagram square", "assignee_id": str(viewer.id), "due_date": "2026-10-20",
        "labels": [{"name": "Design", "color": "purple"}],
        "checklist": [{"id": "a", "text": "Draft copy", "done": True}, {"id": "b", "text": "Print", "done": False}]})
    assert p.status_code == 200, p.text
    body = p.json()
    assert body["assignee"]["email"] == viewer.email and body["labels"][0]["color"] == "purple"
    assert [i["done"] for i in body["checklist"]] == [True, False] and body["description"].startswith("A4")
    # someone outside the business can't be assigned
    outsider = ops["mallory"]
    assert (await mayank.patch(f"/ventures/{v}/cards/{cid}", json={"assignee_id": str(outsider.id)})).status_code == 422
    # encrypted at rest
    conn = await asyncpg.connect(ADMIN_DSN)
    try:
        row = await conn.fetchrow("SELECT title_enc, description_enc, checklist_enc FROM task_cards WHERE id = $1",
                                  uuid.UUID(cid))
    finally:
        await conn.close()
    assert b"Diwali" not in row["title_enc"] and b"Instagram" not in row["description_enc"]
    assert b"Draft copy" not in row["checklist_enc"]

    # drag to the main board, between nothing: lands at the bottom of "In progress"
    main = (await mayank.get(f"/ventures/{v}/boards")).json()[0]
    assert main["is_default"]
    tasks = (await mayank.get(f"/ventures/{v}/boards/{main['id']}")).json()
    m = await mayank.post(f"/ventures/{v}/cards/{cid}/move", json={"list_id": tasks["lists"][1]["id"], "position": 1.5})
    assert m.status_code == 200 and m.json()["board_id"] == main["id"]
    assert _cards((await mayank.get(f"/ventures/{v}/boards/{main['id']}")).json())["Diwali offer poster"]["list"] == "In progress"
    # an archived card on a board being deleted is kept, in the main board's archive
    kept = (await mayank.post(f"/ventures/{v}/cards", json={"list_id": todo, "title": "Old banner idea"})).json()["id"]
    await mayank.patch(f"/ventures/{v}/cards/{kept}", json={"archived": True})
    # the now-empty board can go; the main board can't
    assert (await mayank.delete(f"/ventures/{v}/boards/{nb.json()['id']}")).status_code == 204
    arch = (await mayank.get(f"/ventures/{v}/boards/{main['id']}?archived=true")).json()
    assert "Old banner idea" in _cards(arch)
    assert (await mayank.delete(f"/ventures/{v}/boards/{main['id']}")).status_code == 409
    # a list with cards can't be deleted; rename and add work
    assert (await mayank.delete(f"/ventures/{v}/lists/{tasks['lists'][1]['id']}")).status_code == 409
    nl = await mayank.post(f"/ventures/{v}/boards/{main['id']}/lists", json={"name": "Blocked"})
    assert nl.status_code == 201 and nl.json()["position"] > 4096
    assert (await mayank.patch(f"/ventures/{v}/lists/{nl.json()['id']}", json={"name": "Waiting"})).json()["name"] == "Waiting"
    assert (await mayank.delete(f"/ventures/{v}/lists/{nl.json()['id']}")).status_code == 204


async def test_viewers_read_only_and_outsiders_see_nothing(ops):
    viewer, mallory, v = ops["viewer"], ops["mallory"], ops["ops"]
    boards = (await viewer.get(f"/ventures/{v}/boards")).json()
    board = (await viewer.get(f"/ventures/{v}/boards/{boards[0]['id']}")).json()
    assert board["can_edit"] is False and board["lists"]
    lid = board["lists"][0]["id"]
    assert (await viewer.post(f"/ventures/{v}/cards", json={"list_id": lid, "title": "x"})).status_code == 404
    assert (await viewer.post(f"/ventures/{v}/boards", json={"name": "Mine"})).status_code == 404
    card = next(c for lst in board["lists"] for c in lst["cards"])
    assert (await viewer.post(f"/ventures/{v}/cards/{card['id']}/move", json={"list_id": lid})).status_code == 404
    assert (await mallory.get(f"/ventures/{v}/boards")).status_code == 404
    assert (await mallory.get(f"/ventures/{v}/boards/{boards[0]['id']}")).status_code == 404


async def test_role_restricted_task_cards_stay_hidden(world, fake_llm):
    """A task from a loan-officer-only document is a card only loan officers see."""
    bob, mayank, tru = world["bob"], world["mayank"], world["tru"]
    fake_llm.on("You build a company knowledge graph", {"entities": [], "edges": [], "facts": [
        {"statement": "Collect the Sharma PAN copy", "kind": "task", "source": 0}]})
    files = {"file": ("kyc.txt", io.BytesIO(b"KYC checklist: collect the Sharma PAN copy"), "text/plain")}
    r = await bob.post(f"/ventures/{tru}/documents", files=files, data={"title": "KYC", "restricted_to": "loan_officer"})
    assert r.status_code == 201, r.text
    seen_by = {}
    for who in (bob, mayank):
        b = (await who.get(f"/ventures/{tru}/boards")).json()[0]
        seen_by[who.email] = b["cards"]
    assert seen_by[bob.email] == seen_by[mayank.email] + 1
    # a board holding a card the deleter can't see is not deleted out from under it
    loans = (await mayank.post(f"/ventures/{tru}/boards", json={"name": "Loans"})).json()["id"]
    first = (await bob.get(f"/ventures/{tru}/boards/{loans}")).json()["lists"][0]["id"]
    main = (await bob.get(f"/ventures/{tru}/boards")).json()[0]["id"]
    hidden = next(c for lst in (await bob.get(f"/ventures/{tru}/boards/{main}")).json()["lists"] for c in lst["cards"]
                  if c["title"] == "Collect the Sharma PAN copy")
    assert (await bob.post(f"/ventures/{tru}/cards/{hidden['id']}/move", json={"list_id": first})).status_code == 200
    r = await mayank.delete(f"/ventures/{tru}/boards/{loans}")
    assert r.status_code == 409 and "1 card" in r.json()["detail"]

