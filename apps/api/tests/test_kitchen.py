"""Cloud kitchen: sandboxed forecast + BOM, event multiplier bounded, one approval
per PO by the kitchen manager, deterministic totals, accuracy reporting."""
from __future__ import annotations

import io
import uuid
from datetime import date, timedelta
from decimal import ROUND_CEILING, Decimal

import pytest

from conftest import join, make_actor

pytestmark = pytest.mark.asyncio

TARGET = date.today() + timedelta(days=1)


@pytest.fixture(scope="module")
async def kitchen(world, client):
    mayank, org = world["mayank"], world["org"]
    v = (await mayank.post(f"/orgs/{org}/ventures", json={"name": "Cloud Kitchen", "slug": "kitchen"})).json()["id"]
    assert (await mayank.put(f"/ventures/{v}/settings", json={"kind": "kitchen"})).status_code == 200
    manager = await make_actor(client, "manager")
    cook = await make_actor(client, "cook")
    for who, role in ((manager, "kitchen_manager"), (cook, "operator")):
        await join(mayank, who, org, v, role)
    m = manager
    r = await m.put(f"/ventures/{v}/kitchen/ref/dishes", json={"items": [
        {"code": "biryani", "name": "Chicken Biryani", "price_inr": "249"},
        {"code": "paneer", "name": "Paneer Butter Masala", "price_inr": "229"}]})
    assert r.json() == {"upserted": 2, "errors": []}, r.text
    await m.put(f"/ventures/{v}/kitchen/ref/ingredients", json={"items": [
        {"code": "rice", "name": "Basmati rice", "unit": "kg"}, {"code": "chicken", "name": "Chicken", "unit": "kg"},
        {"code": "paneer", "name": "Paneer", "unit": "kg"}, {"code": "cream", "name": "Cream", "unit": "l"}]})
    await m.put(f"/ventures/{v}/kitchen/ref/vendors", json={"items": [
        {"code": "grains", "name": "Delhi Grains", "email": "orders@grains.example"},
        {"code": "meat", "name": "Fresh Meats", "email": "po@meat.example"},
        {"code": "dairy", "name": "Local Dairy"}]})                     # no email: must be sent manually
    r = await m.put(f"/ventures/{v}/kitchen/recipes", json={"recipes": {
        "biryani": [{"ingredient_code": "rice", "qty_per_portion": "0.15", "wastage_pct": "5"},
                    {"ingredient_code": "chicken", "qty_per_portion": "0.2"}],
        "paneer": [{"ingredient_code": "paneer", "qty_per_portion": "0.15"},
                   {"ingredient_code": "cream", "qty_per_portion": "0.05"}]}})
    assert r.json()["errors"] == []
    await m.put(f"/ventures/{v}/kitchen/vendor-items", json={"items": [
        {"vendor_code": "grains", "ingredient_code": "rice", "sku": "BAS-5", "pack_size": "5", "price_per_pack": "450"},
        {"vendor_code": "meat", "ingredient_code": "chicken", "pack_size": "1", "price_per_pack": "240"},
        {"vendor_code": "dairy", "ingredient_code": "paneer", "pack_size": "1", "price_per_pack": "380"},
        {"vendor_code": "dairy", "ingredient_code": "cream", "pack_size": "1", "price_per_pack": "210"}]})
    await m.post(f"/ventures/{v}/kitchen/stock", json={"counts": [
        {"ingredient_code": "rice", "qty": "3"}, {"ingredient_code": "chicken", "qty": "2"},
        {"ingredient_code": "paneer", "qty": "0"}, {"ingredient_code": "cream", "qty": "5"}]})
    # 8 weeks of sales: biryani 40/day (+20 on weekends), paneer 20/day; via an aggregator-style CSV
    lines = ["Order Date,Item Name,Quantity,Platform"]
    for i in range(56, 0, -1):
        d = TARGET - timedelta(days=i)
        lines.append(f"{d.isoformat()},Chicken Biryani,{40 + (20 if d.weekday() >= 5 else 0)},swiggy")
        lines.append(f"{d.isoformat()},paneer,20,zomato")
    lines.append(f"{(TARGET - timedelta(days=1)).isoformat()},Mystery Dish,3,swiggy")
    r = await m.post(f"/ventures/{v}/kitchen/sales/csv",
                     files={"file": ("sales.csv", io.BytesIO("\n".join(lines).encode()), "text/csv")})
    assert r.json()["upserted"] == 112 and "Mystery Dish" in r.json()["errors"][0]
    return {**world, "kitchen": v, "manager": manager, "cook": cook}


def _expected_packs(portions: Decimal, per: Decimal, wastage: Decimal, stock: Decimal, pack: Decimal) -> int:
    need = portions * per * (1 + wastage / 100) * Decimal("1.10") - stock
    return int((need / pack).to_integral_value(rounding=ROUND_CEILING)) if need > 0 else 0


async def test_daily_plan_end_to_end(kitchen, fake_llm):
    m, cook, v = kitchen["manager"], kitchen["cook"], kitchen["kitchen"]
    r = await m.post(f"/ventures/{v}/kitchen/events", json={"event_date": TARGET.isoformat(), "name": "India vs Pakistan final"})
    assert r.status_code == 201
    fake_llm.on("estimate how an Indian calendar event changes", {"multiplier": 9.0, "reason": "cricket"})  # invalid
    fake_llm.on("cloud-kitchen manager explaining", "Cricket final tomorrow; demand up.")

    run_id = (await m.post(f"/ventures/{v}/kitchen/run", json={"target_date": TARGET.isoformat()})).json()["run_id"]
    run = (await m.get(f"/ventures/{v}/runs/{run_id}")).json()
    assert run["status"] == "waiting", run
    assert [s["step"] for s in run["steps"]][:6] == ["ingest_reports", "forecast", "adjust", "plan", "narrate", "po_gate"]

    plan = (await m.get(f"/ventures/{v}/kitchen/plan?target_date={TARGET.isoformat()}")).json()
    fc = {f["dish_code"]: f for f in plan["forecasts"]}
    # the model's out-of-range multiplier (9.0) failed validation -> fallback 1.0; nothing unbounded gets through
    assert Decimal(fc["biryani"]["event_multiplier"]) <= Decimal("2.0")
    mult = Decimal(fc["biryani"]["event_multiplier"])
    base = 60 if TARGET.weekday() >= 5 else 40
    assert abs(Decimal(fc["biryani"]["model_qty"]) - base) <= 2
    portions = Decimal(fc["biryani"]["final_qty"])
    assert portions == (Decimal(fc["biryani"]["model_qty"]) * mult).to_integral_value(rounding=ROUND_CEILING)

    pos = {p["vendor"]: p for p in plan["purchase_orders"]}
    rice_packs = _expected_packs(portions, Decimal("0.15"), Decimal(5), Decimal(3), Decimal(5))
    rice = pos["Delhi Grains"]["lines"][0]
    assert rice["packs"] == rice_packs and Decimal(pos["Delhi Grains"]["total_inr"]) == rice_packs * Decimal(450)
    assert plan["narrative"].startswith("Cricket final")

    # the cook (operator) can see but not approve; the manager approves one at a time
    first = [a for a in (await cook.get("/approvals/inbox")).json() if a["run_id"] == run_id][0]
    assert not first["can_decide"]
    assert (await cook.post(f"/ventures/{v}/approvals/{first['id']}/decision",
                            json={"decision": "approve"})).status_code == 404
    decisions = {"Delhi Grains": "approve", "Fresh Meats": "reject"}
    seen = []
    for _ in range(4):
        pending = [a for a in (await m.get("/approvals/inbox")).json() if a["run_id"] == run_id]
        if not pending:
            break
        a = pending[0]
        vendor = [name for name in decisions if name in a["title"]][0]
        seen.append(vendor)
        assert a["payload"]["to"] in ("orders@grains.example", "po@meat.example")
        assert (await m.post(f"/ventures/{v}/approvals/{a['id']}/decision",
                             json={"decision": decisions[vendor]})).status_code == 200
    run = (await m.get(f"/ventures/{v}/runs/{run_id}")).json()
    assert run["status"] == "completed", run
    assert sorted(seen) == ["Delhi Grains", "Fresh Meats"]            # the dairy PO has no email: skipped
    statuses = {p["vendor"]: p["status"] for p in
                (await m.get(f"/ventures/{v}/kitchen/plan?target_date={TARGET.isoformat()}")).json()["purchase_orders"]}
    assert statuses == {"Delhi Grains": "sent", "Fresh Meats": "rejected", "Local Dairy": "draft"}
    assert any("send manually" in (s["note"] or "") for s in run["steps"])


async def test_accuracy_report(kitchen, fake_llm):
    m, v = kitchen["manager"], kitchen["kitchen"]
    yesterday = TARGET - timedelta(days=1)
    fake_llm.on("cloud-kitchen manager explaining", "ok")
    run_id = (await m.post(f"/ventures/{v}/kitchen/run", json={"target_date": yesterday.isoformat()})).json()["run_id"]
    for _ in range(3):  # reject all POs so the run finishes
        for a in [a for a in (await m.get("/approvals/inbox")).json() if a["run_id"] == run_id]:
            await m.post(f"/ventures/{v}/approvals/{a['id']}/decision", json={"decision": "reject"})
    acc = (await m.get(f"/ventures/{v}/kitchen/accuracy?days=7")).json()
    assert acc["overall_mape"] is not None and acc["overall_mape"] < 15
    assert {d["dish_code"] for d in acc["dishes"]} == {"biryani", "paneer"}


async def test_kitchen_workflow_refuses_other_venture_kinds(world, kitchen):
    await world["mayank"].put(f"/ventures/{world['site']}/settings", json={"kind": "software"})
    r = await world["alice"].post(f"/ventures/{world['site']}/kitchen/run", json={})
    assert r.status_code == 422      # Sitelytc is a software venture
