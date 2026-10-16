"""Automations from plain words: understood into a schedule, run by the worker at their time, reported from
the business's own numbers, delivered to the person who asked; emails to others wait for a yes."""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from conftest import join, make_actor

pytestmark = pytest.mark.asyncio
IST = ZoneInfo("Asia/Kolkata")


async def test_schedule_arithmetic():
    from kritvia_api.services.automations import describe, next_run, period_range
    wed = datetime(2026, 10, 14, 10, 0, tzinfo=IST)                  # a Wednesday
    assert next_run("weekly", [0], None, "09:00", IST, wed) == datetime(2026, 10, 19, 9, 0, tzinfo=IST)
    assert next_run("daily", [], None, "09:00", IST, wed) == datetime(2026, 10, 15, 9, 0, tzinfo=IST)
    assert next_run("daily", [], None, "18:30", IST, wed) == datetime(2026, 10, 14, 18, 30, tzinfo=IST)
    assert next_run("monthly", [], 1, "08:00", IST, wed) == datetime(2026, 11, 1, 8, 0, tzinfo=IST)
    s, e = period_range("last_week", IST, wed)
    assert (s.date().isoformat(), e.date().isoformat()) == ("2026-10-05", "2026-10-12")
    s, e = period_range("last_month", IST, wed)
    assert (s.date().isoformat(), e.date().isoformat()) == ("2026-09-01", "2026-10-01")
    assert describe("weekly", [0, 4], None, "09:00") == "Every Monday and Friday at 9:00 AM"
    assert describe("monthly", [], 1, "18:15") == "On day 1 of every month at 6:15 PM"


async def test_understand_save_fire_and_deliver(world, client, fake_llm, services):
    from kritvia_api.services.automations import fire_due
    from kritvia_api.services.mailer import get_mailer
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Auto Shop", "slug": f"auto-{uuid.uuid4().hex[:6]}"})).json()["id"]
    await mayank.put(f"/ventures/{v}/settings", json={"kind": "general", "business_name": "Auto Shop", "city": "Delhi"})
    viewer = await make_actor(client, "auto-viewer")
    await join(mayank, viewer, world["org"], v, "viewer")
    today = datetime.now(IST).date()
    inv = (await mayank.post(f"/ventures/{v}/invoices", json={"customer_name": "Kapoor Sweets", "amount_paise": 1250000,
                                                              "due_on": str(today)})).json()
    await mayank.post(f"/ventures/{v}/invoices/{inv['id']}/payment", json={"amount_paise": 1250000})

    fake_llm.on("You turn a business owner's request", {
        "name": "Weekly sales", "task": "Summarise money received and invoices issued", "period": "last_7_days",
        "freq": "weekly", "weekdays": [0], "at_time": "09:00", "channel": "email", "recipients": []})
    u = await mayank.post(f"/ventures/{v}/automations/understand", json={"text": "har Monday subah 9 baje sales bhejo"})
    assert u.status_code == 200, u.text
    d = u.json()
    assert d["when"] == "Every Monday at 9:00 AM" and d["said"] == "har Monday subah 9 baje sales bhejo"
    body = {k: d[k] for k in ("name", "task", "period", "freq", "weekdays", "day_of_month", "at_time", "channel",
                              "recipients", "said")}
    assert (await viewer.post(f"/ventures/{v}/automations", json=body)).status_code == 403
    bad = await mayank.post(f"/ventures/{v}/automations", json={**body, "weekdays": []})
    assert bad.status_code == 422
    a = (await mayank.post(f"/ventures/{v}/automations", json={**body, "period": "today"})).json()
    nxt = datetime.fromisoformat(a["next_run_at"]).astimezone(IST)
    assert nxt.weekday() == 0 and nxt.strftime("%H:%M") == "09:00" and nxt > datetime.now(IST)

    # the worker fires it at its time (and only once), then sets the next Monday
    fake_llm.on("You prepare a short report", lambda m: {
        "subject": "Sales today", "body": "Money received: ₹12,500 in 1 payment(s)." if "₹12,500" in str(m) else "no data"})
    outbox = get_mailer().outbox
    before = len(outbox)
    assert await fire_due(services, nxt.astimezone(UTC) + timedelta(seconds=30)) == 1
    assert await fire_due(services, nxt.astimezone(UTC) + timedelta(seconds=40)) == 0
    sent = [m for m in outbox[before:] if m["To"] == mayank.email]
    assert len(sent) == 1 and sent[0]["Subject"] == "Sales today" and "₹12,500" in sent[0].get_content()
    after = next(x for x in (await mayank.get(f"/ventures/{v}/automations")).json() if x["id"] == a["id"])
    assert datetime.fromisoformat(after["next_run_at"]) - nxt >= timedelta(days=7) - timedelta(minutes=1)
    res = (await viewer.get(f"/ventures/{v}/automations/{a['id']}/results")).json()
    assert res[0]["text"].startswith("Sales today") and res[0]["delivered"] == "emailed to you"

    # to other people: an email that waits for a yes
    b = (await mayank.post(f"/ventures/{v}/automations", json={**body, "name": "For the CA", "period": "today",
                                                                "recipients": ["ca@example.com"]})).json()
    r = await mayank.post(f"/ventures/{v}/automations/{b['id']}/run")
    assert r.status_code == 201
    ap = [x for x in (await mayank.get(f"/ventures/{v}/approvals")).json() if x["run_id"] == r.json()["run_id"]]
    assert ap and ap[0]["payload"]["to"] == "ca@example.com" and ap[0]["status"] == "pending"

    # switched off: not run; only its maker or an admin may change it
    assert (await viewer.patch(f"/ventures/{v}/automations/{a['id']}", json={"enabled": False})).status_code == 403
    off = await mayank.patch(f"/ventures/{v}/automations/{a['id']}", json={"enabled": False})
    assert off.json()["enabled"] is False and off.json()["next_run_at"] is None
    assert (await mayank.delete(f"/ventures/{v}/automations/{b['id']}")).status_code == 204
