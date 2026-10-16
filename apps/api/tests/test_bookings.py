"""Bookings from chat: opening hours and services, free times, the Inbox assistant offering and confirming a
time (the booking is made when the reply is approved, and re-checked then), and day-before reminders."""
from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from conftest import join, make_actor

pytestmark = pytest.mark.asyncio
IST = ZoneInfo("Asia/Kolkata")
ALL_WEEK = {d: [["10:00", "13:00"], ["14:00", "19:00"]] for d in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")}


async def test_free_slot_arithmetic():
    from kritvia_api.services.bookings import Settings, clean_hours, free_slots, spread
    with pytest.raises(ValueError):
        clean_hours({"mon": [["13:00", "10:00"]]})
    with pytest.raises(ValueError):
        clean_hours({"funday": [["10:00", "11:00"]]})
    with pytest.raises(ValueError):
        clean_hours({"mon": [["10:00", "12:00"], ["11:00", "13:00"]]})
    s = Settings(True, {"mon": [["10:00", "12:00"]]}, 30, 0, 7, 2, False, IST)
    monday = datetime(2026, 10, 19, 8, 0, tzinfo=IST)          # a Monday, 8 am
    slots = free_slots(s, 60, monday, [], [])
    assert [t.strftime("%H:%M") for t in slots] == ["10:00", "10:30", "11:00"]
    t10 = datetime(2026, 10, 19, 10, 0, tzinfo=IST)
    one = [(t10, t10 + timedelta(minutes=60))]
    assert len(free_slots(s, 60, monday, one, [])) == 3                  # capacity 2: one booking leaves room
    assert [t.strftime("%H:%M") for t in free_slots(s, 60, monday, one * 2, [])] == ["11:00"]
    assert [t.strftime("%H:%M") for t in free_slots(s, 60, monday, [], [(t10, t10 + timedelta(minutes=30))])] == ["10:30", "11:00"]
    late = datetime(2026, 10, 19, 10, 20, tzinfo=IST)                  # notice: nothing before now
    assert [t.strftime("%H:%M") for t in free_slots(s, 30, late, [], [])][:1] == ["10:30"]
    assert len(spread(free_slots(Settings(True, ALL_WEEK, 30, 0, 7, 1, False, IST), 30, monday, [], []), 8)) == 8


@pytest.fixture(scope="module")
async def salon(world, client):
    mayank = world["mayank"]
    v = (await mayank.post(f"/orgs/{world['org']}/ventures",
                           json={"name": "Glow Bookings", "slug": f"glowbk-{uuid.uuid4().hex[:6]}"})).json()["id"]
    await mayank.put(f"/ventures/{v}/settings", json={"kind": "general", "business_name": "Glow Salon", "city": "Pune"})
    operator = await make_actor(client, "bk-operator")
    await join(mayank, operator, world["org"], v, "operator")
    return {**world, "v": v, "operator": operator}


async def test_settings_services_and_manual_bookings(salon):
    mayank, operator, v = salon["mayank"], salon["operator"], salon["v"]
    assert (await operator.get(f"/ventures/{v}/booking-settings")).json()["configured"] is False
    assert (await operator.put(f"/ventures/{v}/booking-settings", json={"hours": ALL_WEEK})).status_code == 403
    bad = await mayank.put(f"/ventures/{v}/booking-settings", json={"hours": {"mon": [["19:00", "10:00"]]}})
    assert bad.status_code == 422
    r = await mayank.put(f"/ventures/{v}/booking-settings",
                         json={"hours": ALL_WEEK, "slot_minutes": 30, "notice_hours": 0, "capacity": 1, "use_calendar": False})
    assert r.status_code == 200 and r.json()["configured"] is True
    cut = (await mayank.post(f"/ventures/{v}/booking-services", json={"name": "Haircut", "minutes": 30,
                                                                     "price_paise": 40000})).json()
    assert (await mayank.post(f"/ventures/{v}/booking-services", json={"name": "haircut", "minutes": 45})).status_code == 409
    await mayank.post(f"/ventures/{v}/booking-services", json={"name": "Facial", "minutes": 60, "price_paise": 90000})
    assert [x["name"] for x in (await operator.get(f"/ventures/{v}/booking-services")).json()] == ["Facial", "Haircut"]

    free = (await operator.get(f"/ventures/{v}/booking-slots", params={"service_id": cut["id"], "days": 3})).json()["slots"]
    assert free
    first = free[0]
    b = await operator.post(f"/ventures/{v}/bookings", json={"service_id": cut["id"], "starts_at": first,
                                                             "customer_name": "Walk-in Ravi", "phone": "98111 22233"})
    assert b.status_code == 201, b.text
    assert b.json()["channel"] == "whatsapp" and b.json()["address"] == "919811122233"
    again = await operator.post(f"/ventures/{v}/bookings", json={"service_id": cut["id"], "starts_at": first,
                                                                 "customer_name": "Someone else"})
    assert again.status_code == 409
    after = (await operator.get(f"/ventures/{v}/booking-slots", params={"service_id": cut["id"], "days": 3})).json()["slots"]
    assert first not in after
    done = await operator.patch(f"/ventures/{v}/bookings/{b.json()['id']}", json={"status": "cancelled"})
    assert done.json()["status"] == "cancelled"
    assert first in (await operator.get(f"/ventures/{v}/booking-slots",
                                        params={"service_id": cut["id"], "days": 3})).json()["slots"]


def _reply_choosing_first_code(messages) -> dict:
    prompt = json.dumps(messages, ensure_ascii=False)
    code = re.search(r"\[(1[a-h])\]", prompt).group(1)
    return {"subject": "", "body": "Done! Your haircut is booked. See you then.", "used_sources": [],
            "unsure": False, "booking": {"service": 1, "slot": code}}


async def test_chat_books_on_approval_and_reminds(salon, fake_llm):
    mayank, v = salon["mayank"], salon["v"]
    # Facial is service 1 (alphabetical); make Haircut the only one so the code is unambiguous
    for s in (await mayank.get(f"/ventures/{v}/booking-services")).json():
        if s["name"] == "Facial":
            await mayank.delete(f"/ventures/{v}/booking-services/{s['id']}")
    assert (await mayank.put(f"/ventures/{v}/workflow-configs/inbox_assistant",
                             json={"enabled": True, "settings": {"hand_off_leads": False}, "instructions": ""})).status_code == 200
    fake_llm.on("You sort the business's incoming messages", {
        "category": "scheduling", "summary": "Asha wants a haircut tomorrow.", "needs_reply": True,
        "language": "en", "urgency": "medium", "wants_person": False})
    fake_llm.on("You answer the business's", _reply_choosing_first_code)

    async def ask(name: str, email: str) -> dict:
        r = await mayank.post(f"/ventures/{v}/runs", json={"workflow": "inbox_assistant", "input": {
            "channel": "email", "from_name": name, "from_email": email, "subject": "Haircut",
            "body": "Can I book a haircut at your first free time?", "message_id": None, "thread_id": None}})
        assert r.status_code == 201, r.text
        return [a for a in (await mayank.get(f"/ventures/{v}/approvals")).json() if a["run_id"] == r.json()["id"]][0]

    a1 = await ask("Asha", "asha@example.com")
    prompt = fake_llm.chat_calls("You answer the business's")[-1]["prompt"]
    assert "Bookable services and free times" in prompt and "Haircut (30 min, ₹400)" in prompt
    assert a1["title"].startswith("Booking: Haircut") and a1["payload"]["booking"]["service"] == "Haircut"
    # a second customer is offered the same first time before the first one is approved
    a2 = await ask("Bina", "bina@example.com")
    assert a2["payload"]["booking"]["starts_at"] == a1["payload"]["booking"]["starts_at"]

    assert (await mayank.post(f"/ventures/{v}/approvals/{a1['id']}/decision", json={"decision": "approve"})).status_code == 200
    run1 = (await mayank.get(f"/ventures/{v}/runs/{a1['run_id']}")).json()
    assert run1["outcome"] == "replied" and run1["summary"]["booking"]["service"] == "Haircut"
    bks = (await mayank.get(f"/ventures/{v}/bookings")).json()
    mine = [b for b in bks if b["customer_name"] == "Asha"]
    assert len(mine) == 1 and mine[0]["from_chat"] and mine[0]["channel"] == "email"
    assert mine[0]["address"] == "asha@example.com"

    # the second approval finds the time gone: no booking, no reply; it is redrafted with other times
    assert (await mayank.post(f"/ventures/{v}/approvals/{a2['id']}/decision", json={"decision": "approve"})).status_code == 200
    run2 = (await mayank.get(f"/ventures/{v}/runs/{a2['run_id']}")).json()
    assert run2["status"] == "waiting"
    redraft = [a for a in (await mayank.get(f"/ventures/{v}/approvals")).json()
               if a["run_id"] == a2["run_id"] and a["status"] == "pending"][0]
    assert redraft["payload"]["booking"]["starts_at"] != a1["payload"]["booking"]["starts_at"]
    assert "can't be booked" in fake_llm.chat_calls("You answer the business's")[-1]["prompt"]
    assert not [b for b in (await mayank.get(f"/ventures/{v}/bookings")).json() if b["customer_name"] == "Bina"]

    # day-before reminders, drafted from the booking itself
    tomorrow = datetime.now(IST).date() + timedelta(days=1)
    svc = (await mayank.get(f"/ventures/{v}/booking-services")).json()[0]
    at = datetime(tomorrow.year, tomorrow.month, tomorrow.day, 16, 0, tzinfo=IST)
    b = await mayank.post(f"/ventures/{v}/bookings", json={"service_id": svc["id"], "starts_at": at.isoformat(),
                                                           "customer_name": "Chitra Rao", "phone": "+91 99887 76655",
                                                           "outside_hours": True})
    assert b.status_code == 201, b.text
    assert (await mayank.put(f"/ventures/{v}/workflow-configs/booking_reminders", json={
        "enabled": True, "schedule": "18:00", "settings": {"note": "Parking is behind the building."},
        "instructions": ""})).status_code == 200
    r = await mayank.post(f"/ventures/{v}/runs", json={"workflow": "booking_reminders", "input": {}})
    assert r.status_code == 201
    rem = [a for a in (await mayank.get(f"/ventures/{v}/approvals")).json() if a["action"] == "whatsapp.send"
           and a["payload"]["to"] == "919988776655"]
    assert len(rem) == 1
    body = rem[0]["payload"]["body"]
    assert body.startswith("Hi Chitra, a reminder of your Haircut at Glow Salon tomorrow") and "4:00 PM" in body
    assert body.endswith("Parking is behind the building.")
    # run again: not reminded twice while one waits
    await mayank.post(f"/ventures/{v}/runs", json={"workflow": "booking_reminders", "input": {}})
    assert len([a for a in (await mayank.get(f"/ventures/{v}/approvals")).json() if a["action"] == "whatsapp.send"
                and a["payload"]["to"] == "919988776655"]) == 1

