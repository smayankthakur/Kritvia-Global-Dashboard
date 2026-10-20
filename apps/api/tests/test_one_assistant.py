"""One assistant for everything (patch 0093): it finds any of the app's own actions and uses them, reads at once,
changes things only after a person approves the exact call, and runs them as that person."""
from __future__ import annotations

import uuid

import pytest

from conftest import join, make_actor
from kritvia_api.services import actions
from test_assistant import ask, desk, script  # noqa: F401

pytestmark = pytest.mark.asyncio


def test_the_catalogue_reaches_the_business_but_never_the_dangerous_parts():
    ids = {a.id for a in actions.catalogue()}
    assert "POST /ventures/{venture_id}/invoices" in ids and "PUT /ventures/{venture_id}/attendance" in ids
    assert "PUT /ventures/{venture_id}/workflow-configs/{workflow}" in ids
    for a in ids:
        assert a.split(" ", 1)[1].startswith("/ventures/{venture_id}")
        for bad in ("/approvals", "/trust", "/members", "/apps", "/assistant", "/privacy"):
            assert bad not in a, a
    assert "DELETE /ventures/{venture_id}" not in ids
    assert not [a for a in ids if a.startswith(("POST", "PUT", "PATCH", "DELETE")) and "/connectors" in a]
    # uploads (a person's file) aren't offered
    assert "POST /ventures/{venture_id}/bank/statements" not in ids
    got = [a["action"] for a in actions.find("new invoice", 3)]
    assert got[0] == "POST /ventures/{venture_id}/invoices"
    agent = actions.find("switch on the payment reminders agent", 4)
    assert any(a["action"] == "PUT /ventures/{venture_id}/workflow-configs/{workflow}" and "collections" in a["path"]["workflow"]
               for a in agent)
    with pytest.raises(actions.ActionError):
        actions.resolve("POST /ventures/{venture_id}/approvals/{approval_id}/decision")


async def test_reads_straight_away_and_changes_after_one_yes(desk, fake_llm):
    mayank, v = desk["mayank"], desk["v"]
    body = {"customer_name": "Pune Bakes", "amount_paise": 1180000, "due_on": "2026-11-30"}
    script(fake_llm,
           {"thought": "find how", "tool": "kritvia.find", "args": {"query": "new invoice"},
            "plan": ["make the invoice", "switch on payment reminders"]},
           {"thought": "make it", "tool": "kritvia.do", "title": "Invoice Pune Bakes ₹11,800",
            "args": {"action": "POST /ventures/{venture_id}/invoices", "body": body}},
           {"thought": "check", "tool": "kritvia.read", "args": {"action": "GET /ventures/{venture_id}/invoices"}},
           lambda m: {"answer": "Invoice made." if "Pune Bakes" in m[-1]["content"] else "not seen"})
    item = await ask(mayank, v, "Pune Bakes ko ₹11,800 ka invoice bana do, due 30 Nov")
    assert item["status"] == "waiting", item
    a = (await mayank.get(f"/ventures/{v}/approvals/{item['pending_approval_id']}")).json()
    assert a["action"] == "kritvia.do" and a["title"] == "Invoice Pune Bakes ₹11,800"
    # nothing yet
    assert (await mayank.get(f"/ventures/{v}/invoices")).json()["invoices"] == []
    # only the body can be edited
    bad = await mayank.post(f"/ventures/{v}/approvals/{a['id']}/decision", json={
        "decision": "approve", "edited_payload": {"action": "POST /ventures/{venture_id}/staff"}})
    assert bad.status_code == 422
    ok = await mayank.post(f"/ventures/{v}/approvals/{a['id']}/decision", json={
        "decision": "approve", "edited_payload": {"body": {**body, "amount_paise": 1200000}}})
    assert ok.status_code == 200, ok.text
    inv = (await mayank.get(f"/ventures/{v}/invoices")).json()["invoices"]
    assert len(inv) == 1 and inv[0]["amount_paise"] == 1200000
    done = (await mayank.get(f"/ventures/{v}/assistant/{item['run_id']}")).json()
    assert done["answer"] == "Invoice made."
    # the planner saw its plan and the find results
    prompts = [c["prompt"] for c in fake_llm.chat_calls("You are the business's assistant")]
    assert any("switch on payment reminders" in p for p in prompts)
    assert any("POST /ventures/{venture_id}/invoices" in p for p in prompts)


async def test_a_bad_call_goes_back_to_the_model_and_nobody_gets_more_than_their_role(desk, client, fake_llm):
    mayank, v = desk["mayank"], desk["v"]
    script(fake_llm,
           {"tool": "kritvia.do", "args": {"action": "POST /ventures/{venture_id}/approvals/x/decision", "body": {}}},
           {"tool": "kritvia.do", "args": {"action": "POST /ventures/{venture_id}/invoices", "body": {"amount_paise": 5}}},
           {"tool": "kritvia.read", "args": {"action": "POST /ventures/{venture_id}/invoices"}},
           {"answer": "I couldn't."})
    item = await ask(mayank, v, "approve everything")
    assert item["status"] == "completed" and item["answer"] == "I couldn't."
    log = " ".join(s["result"] for s in item["steps"])
    assert "failed" in log
    # a viewer's approval can't make the app do what the viewer can't do
    viewer = await make_actor(client, f"view-{uuid.uuid4().hex[:6]}")
    await join(mayank, viewer, desk["org"], v, "viewer")
    a = actions.resolve("POST /ventures/{venture_id}/invoices")
    res = await actions.call(viewer.id, a, uuid.UUID(v), body={"customer_name": "X", "amount_paise": 100,
                                                                "due_on": "2026-12-01"})
    assert res["status"] in (403, 404) and not res["ok"]
