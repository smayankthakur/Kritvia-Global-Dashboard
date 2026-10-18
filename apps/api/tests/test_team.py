"""The agent team: each role's lead has a goal and checks in on its days (or when asked), works through the
assistant, hands work to another lead (at most two deep), stays within its role's budget and reports to
the owner. Business templates add a whole starter kit, once, without touching what is already there."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime

import asyncpg
import pytest

from conftest import ADMIN_DSN, join, make_actor
from kritvia_api.services import team as tm
from kritvia_api.services import templates as tpl

MARK = "You are the business's assistant"


@pytest.fixture
async def shop(world, client):
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Team Shop", "slug": f"team-{uuid.uuid4().hex[:6]}"})).json()["id"]
    await mayank.put(f"/ventures/{v}/settings", json={"kind": "general", "business_name": "Team Shop", "city": "Pune"})
    operator = await make_actor(client, "team-operator")
    await join(mayank, operator, world["org"], v, "operator")
    viewer = await make_actor(client, "team-viewer")
    await join(mayank, viewer, world["org"], v, "viewer")
    return {**world, "v": v, "operator": operator, "viewer": viewer}


def lead_of(prompt: str) -> str:
    for role, title in tm.TITLES.items():
        if f"You are the {title} lead" in prompt:
            return role
    return "assistant"


def team_llm(fake_llm, script: dict[str, list]):
    """script: lead -> its steps (each a reply dict), one per think() call of that lead's run."""
    seen: dict[str, int] = {}
    prompts: list[str] = []

    def reply(messages):
        p = messages[-1]["content"]
        prompts.append(p)
        who = lead_of(p)
        i = seen.get(who, 0)
        seen[who] = i + 1
        steps = script.get(who) or [{"answer": "ok"}]
        return steps[min(i, len(steps) - 1)]
    fake_llm.on(MARK, reply)
    return prompts


async def lead(actor, v, role, **kw):
    body = {"goal": f"Do well at {role}.", "enabled": True, "weekdays": [0, 1, 2, 3, 4, 5, 6], "at_time": "09:30", **kw}
    return await actor.put(f"/ventures/{v}/team/{role}", json=body)


async def test_a_lead_checks_in_and_reports(shop, fake_llm):
    mayank, operator, viewer, v = shop["mayank"], shop["operator"], shop["viewer"], shop["v"]
    t = (await viewer.get(f"/ventures/{v}/team")).json()
    assert [x["role"] for x in t["leads"]] == list(tm.ROLES)
    assert not any(x["set_up"] or x["enabled"] for x in t["leads"]) and t["can_admin"] is False and t["can_check_in"] is False
    assert t["leads"][1]["goal"] == tm.DEFAULT_GOALS["sales"]
    # only admins set up the team; viewers can't ask for a check-in
    assert (await lead(operator, v, "sales")).status_code == 403
    r = await lead(mayank, v, "sales", goal="Every enquiry answered the same day.")
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["set_up"] and got["enabled"] and got["when"] == "Every day at 09:30" and got["next_run_at"]
    assert (await viewer.post(f"/ventures/{v}/team/sales/check-in")).status_code == 403
    assert (await operator.post(f"/ventures/{v}/team/ops/check-in")).status_code == 404   # no goal yet

    prompts = team_llm(fake_llm, {"sales": [{"tool": "business.numbers", "args": {"period": "last_7_days"}},
                                            {"answer": "3 new leads, 1 replied. Drafted 2 follow-ups for your yes."}]})
    r = await operator.post(f"/ventures/{v}/team/sales/check-in")
    assert r.status_code == 201, r.text
    run = r.json()["run_id"]
    assert "You are the Sales lead" in prompts[0] and "Every enquiry answered the same day." in prompts[0]
    assert "team.handoff" in prompts[0]
    t = (await mayank.get(f"/ventures/{v}/team")).json()
    sales = next(x for x in t["leads"] if x["role"] == "sales")
    assert sales["latest_report"].startswith("3 new leads")
    reps = (await viewer.get(f"/ventures/{v}/team/reports", params={"role": "sales"})).json()
    assert len(reps) == 1 and reps[0]["run_id"] == run and reps[0]["title"] == "Sales"
    board = (await mayank.get(f"/ventures/{v}/board")).json()
    card = next(c for c in board["tickets"] if c["run_id"] == run)
    assert card["role"] == "sales" and card["title"] == "Sales lead: check-in"


async def test_check_ins_on_schedule_hand_offs_and_budget(shop, fake_llm, services):
    mayank, v = shop["mayank"], shop["v"]
    for role in ("sales", "accounts", "ops"):
        assert (await lead(mayank, v, role)).status_code == 200
    hand = lambda to: {"tool": "team.handoff", "args": {"to": to, "note": f"Please take this over, {to}."}}  # noqa: E731
    prompts = team_llm(fake_llm, {
        "sales": [hand("front_desk"), hand("accounts"), {"answer": "Handed the overdue invoice to Accounts."}],
        "accounts": [hand("ops"), {"answer": "Reminder drafted."}],
        "ops": [hand("sales"), {"answer": "Task added."}],
    })
    admin = await asyncpg.connect(ADMIN_DSN)
    try:
        await admin.execute("UPDATE team_roles SET next_run_at = now() - interval '1 minute' WHERE venture_id = $1"
                            " AND role = 'sales'", uuid.UUID(v))
        assert await tm.fire_due(services) == 1
        nxt = await admin.fetchval("SELECT next_run_at FROM team_roles WHERE venture_id = $1 AND role = 'sales'",
                                   uuid.UUID(v))
        assert nxt > datetime.now(UTC)
        refs = [r["trigger_ref"] for r in await admin.fetch(
            "SELECT trigger_ref FROM workflow_runs WHERE venture_id = $1 ORDER BY created_at", uuid.UUID(v))]
    finally:
        await admin.close()
    # sales -> accounts (1) -> ops (2); ops can't hand on again; front desk isn't switched on
    assert refs == ["team:sales", "team:accounts:handoff:1", "team:ops:handoff:2"]
    log = "\n".join(prompts)
    assert "the Front desk lead isn't switched on" in log
    assert "already handed on twice" in log
    assert any("The Sales lead handed you this" in p and "You are the Accounts lead" in p for p in prompts)
    reps = (await mayank.get(f"/ventures/{v}/team/reports")).json()
    assert {r["role"] for r in reps} == {"sales", "accounts", "ops"}

    # a role over its monthly budget doesn't check in
    assert (await lead(mayank, v, "sales", monthly_tokens=0)).status_code == 200
    assert (await mayank.post(f"/ventures/{v}/team/sales/check-in")).status_code == 402
    admin = await asyncpg.connect(ADMIN_DSN)
    try:
        await admin.execute("UPDATE team_roles SET next_run_at = now() - interval '1 minute' WHERE venture_id = $1"
                            " AND role = 'sales'", uuid.UUID(v))
        assert await tm.fire_due(services) == 0
        err = await admin.fetchval("SELECT last_error FROM team_roles WHERE venture_id = $1 AND role = 'sales'", uuid.UUID(v))
    finally:
        await admin.close()
    assert err == "this role's monthly budget is used up"
    # switched off: no next check-in
    r = await lead(mayank, v, "sales", enabled=False)
    assert r.json()["enabled"] is False and r.json()["next_run_at"] is None


async def test_templates_add_a_starter_kit_once(shop, client):
    mayank, operator, v = shop["mayank"], shop["operator"], shop["v"]
    kits = (await mayank.get("/templates")).json()
    assert {k["key"] for k in kits} == set(tpl.KITS) and len(kits) == 8
    clinic = next(k for k in kits if k["key"] == "clinic")
    assert clinic["skills"] == ["After-visit follow-up"] and clinic["leads"] == ["Front desk"]
    assert (await operator.post(f"/ventures/{v}/templates/clinic/apply")).status_code == 403
    assert (await mayank.post(f"/ventures/{v}/templates/nope/apply")).status_code == 404
    # something already there is left alone
    await mayank.post(f"/ventures/{v}/skills", json={"name": "After-visit follow-up", "trigger": "manual",
                                                      "instructions": "1. My own way of doing it."})
    r = await mayank.post(f"/ventures/{v}/templates/clinic/apply")
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["automations"] == ["Tomorrow's appointments"] and out["skills"] == [] and out["leads"] == ["Front desk"]
    assert len(out["agents"]) + len(out["skipped"]) == 3
    skills = (await mayank.get(f"/ventures/{v}/skills")).json()
    assert len(skills) == 1 and "My own way" in skills[0]["instructions"]
    team = (await mayank.get(f"/ventures/{v}/team")).json()
    front = next(x for x in team["leads"] if x["role"] == "front_desk")
    assert front["enabled"] and front["goal"].startswith("Every enquiry is answered within the hour")
    autos = (await mayank.get(f"/ventures/{v}/automations")).json()
    assert [a["name"] for a in autos] == ["Tomorrow's appointments"] and autos[0]["next_run_at"]
    # applying again adds nothing
    again = (await mayank.post(f"/ventures/{v}/templates/clinic/apply")).json()
    assert again["agents"] == again["automations"] == again["skills"] == again["leads"] == []

    # a kit for a kind of business sets the kind when the business was General
    r = await mayank.post(f"/ventures/{v}/templates/restaurant/apply")
    assert r.status_code == 200, r.text
    assert r.json()["notes"] == ["Business type set to Kitchen (it was General)"]
    assert "Bulk order enquiries" in r.json()["skills"]
    settings = (await mayank.get(f"/ventures/{v}/settings")).json()
    assert settings["kind"] == "kitchen"


def test_every_kit_uses_real_agents_and_valid_rows():
    from kritvia_api.engine.core import registry
    from kritvia_api.services import automations as au
    from kritvia_api.services import skills as sk
    for k in tpl.KITS.values():
        assert k.kind in tpl.KIND_TITLES
        assert all(a in registry for a in k.agents), k.key
        for a in k.automations:
            assert a["period"] in au.PERIODS and 1 <= len(a["name"]) <= 80 and len(a["said"]) >= 3
        for s in k.skills:
            sk.clean(sk.Draft(**s))
        assert set(k.leads) <= set(tm.ROLES)
