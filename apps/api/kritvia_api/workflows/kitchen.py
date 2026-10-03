"""Cloud kitchen — daily demand forecast & purchase orders (cron 23:30 IST).

  ingest_reports -> forecast (sandbox) -> adjust (events) -> plan (BOM, sandbox)
  -> narrate -> po_gate -> [approval per PO: gmail.send, kitchen_manager] -> send_po -> po_gate ...

Every number (forecast, multiplier application, quantities, pack rounding, PO
totals) is computed by code in the sandbox. The model only interprets free-text
calendar events into a bounded multiplier and writes the morning explanation.
"""
from __future__ import annotations

import csv
import io
import json
import math
import uuid
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, Field
from sqlalchemy import text

from kritvia_api.engine.context import RunContext
from kritvia_api.engine.core import ApprovalRequest, Finish, Goto, Interrupt, Option, Workflow, registry
from kritvia_api.services.memory import RAW_PURPOSE
from kritvia_api.workflows.common import fmt_inr, name_similarity, parse_date, today_ist

wf = registry.register(Workflow(
    "kitchen_daily", title="Demand forecast & purchase orders", start="ingest_reports",
    venture_kinds=("kitchen", "general"), max_steps=120, trigger="Every night at the scheduled time",
    description="Forecasts tomorrow's demand per dish, converts it to ingredients via recipes, subtracts stock and "
                "drafts vendor POs for the kitchen manager's morning approval.",
    options=(
        Option("safety_stock_pct", "Safety stock %", "number", 10, min=0, max=100),
        Option("history_days", "Days of sales history to learn from", "number", 120, min=14, max=730),
        Option("min_history_days", "Minimum days of history before forecasting", "number", 7, min=1, max=60),
    )))

DEFAULTS = {"history_days": 120, "safety_stock_pct": 10, "min_history_days": 7}
MULT_MIN, MULT_MAX = 0.5, 2.0


class EventImpact(BaseModel):
    multiplier: float = Field(ge=MULT_MIN, le=MULT_MAX,
                              description="expected demand vs a normal same weekday, e.g. 1.3 = +30%")
    reason: str


class ReportRows(BaseModel):
    class Row(BaseModel):
        date: str
        dish: str
        qty: float = Field(ge=0)
        channel: str = "all"
    rows: list[Row] = Field(default_factory=list)


def _target(state: dict) -> date:
    t = state["input"].get("target_date")
    return date.fromisoformat(t) if t else today_ist() + timedelta(days=1)


# --------------------------------------------------------------------- reports --
def parse_sales_csv(raw: bytes, dishes: dict[str, uuid.UUID], names: dict[str, uuid.UUID]
                    ) -> tuple[list[dict[str, Any]], list[str]]:
    """Accepts aggregator exports or our template: date, dish (code or name), qty[, channel, revenue]."""
    text_ = raw.decode("utf-8-sig", "replace")
    reader = csv.DictReader(io.StringIO(text_))
    cols = {c.lower().strip(): c for c in reader.fieldnames or []}

    def col(*opts: str) -> str | None:
        for o in opts:
            if o in cols:
                return cols[o]
        return None
    c_date = col("date", "order date", "order_date", "sale_date", "day")
    c_dish = col("dish", "item", "item name", "item_name", "dish_code", "code", "product")
    c_qty = col("qty", "quantity", "units", "count", "orders")
    c_chan = col("channel", "platform", "source")
    c_rev = col("revenue", "amount", "sales", "net sales", "revenue_inr")
    if not (c_date and c_dish and c_qty):
        return [], ["CSV needs date, dish/item and qty columns"]
    rows, unknown = {}, set()
    for rec in reader:
        d = parse_date((rec.get(c_date) or "").strip()[:10]) or parse_date((rec.get(c_date) or "").strip())
        if not d:
            continue
        key = (rec.get(c_dish) or "").strip()
        dish_id = dishes.get(key.lower()) or names.get(key.lower())
        if dish_id is None:
            best = max(names.items(), key=lambda kv: name_similarity(kv[0], key), default=None)
            if best and name_similarity(best[0], key) >= 0.85:
                dish_id = best[1]
        if dish_id is None:
            unknown.add(key)
            continue
        chan = (rec.get(c_chan) or "all").strip().lower() if c_chan else "all"
        chan = chan if chan in ("swiggy", "zomato", "direct", "other") else "all"
        try:
            qty = float((rec.get(c_qty) or "0").replace(",", ""))
        except ValueError:
            continue
        rev = None
        if c_rev and rec.get(c_rev):
            try:
                rev = float(rec[c_rev].replace(",", "").replace("₹", ""))
            except ValueError:
                rev = None
        k = (d, dish_id, chan)
        prev = rows.get(k, {"qty": 0.0, "revenue": None})
        rows[k] = {"qty": prev["qty"] + qty,
                   "revenue": (prev["revenue"] or 0) + rev if rev is not None else prev["revenue"]}
    out = [{"date": k[0].isoformat(), "dish_id": str(k[1]), "channel": k[2], **v} for k, v in rows.items()]
    warnings = [f"unknown dish '{u}'" for u in sorted(unknown)[:20]]
    return out, warnings


async def upsert_sales(conn, org_id: uuid.UUID, venture_id: uuid.UUID, rows: list[dict[str, Any]], source: str) -> int:
    for r in rows:
        await conn.execute(text(
            "INSERT INTO sales_daily (org_id, venture_id, sale_date, dish_id, channel, qty, revenue_inr, source)"
            " VALUES (:o, :v, :d, :dish, :c, :q, :rev, :s)"
            " ON CONFLICT (venture_id, sale_date, dish_id, channel)"
            " DO UPDATE SET qty = EXCLUDED.qty, revenue_inr = coalesce(EXCLUDED.revenue_inr, sales_daily.revenue_inr),"
            " source = EXCLUDED.source"),
            {"o": org_id, "v": venture_id, "d": date.fromisoformat(r["date"]), "dish": uuid.UUID(r["dish_id"]), "c": r["channel"],
             "q": r["qty"], "rev": r.get("revenue"), "s": source})
    return len(rows)


async def dish_maps(conn, venture_id: uuid.UUID) -> tuple[dict[str, uuid.UUID], dict[str, uuid.UUID]]:
    rows = (await conn.execute(text("SELECT id, code, name FROM dishes WHERE venture_id = :v AND active"),
                               {"v": venture_id})).all()
    return {r.code.lower(): r.id for r in rows}, {r.name.lower(): r.id for r in rows}


@wf.step("ingest_reports", agent="ingestion")
async def ingest_reports(ctx: RunContext, state: dict) -> Goto:
    """Parse aggregator sales reports that arrived by email since the last run."""
    parsed, warnings = 0, []
    async with ctx.tx() as conn:
        reports = (await conn.execute(text(
            "SELECT id, title, mime, raw_enc FROM documents WHERE venture_id = :v AND kind = 'report'"
            " AND coalesce((meta->>'parsed')::boolean, false) = false ORDER BY created_at LIMIT 20"),
            {"v": ctx.venture_id})).all()
        codes, names = await dish_maps(conn, ctx.venture_id)
    for rep in reports:
        async with ctx.tx() as conn:
            raw = await ctx.crypto(conn).decrypt(ctx.venture_id, RAW_PURPOSE, rep.raw_enc) if rep.raw_enc else b""
        rows: list[dict[str, Any]] = []
        if (rep.mime or "").endswith("csv") or rep.title.lower().endswith(".csv"):
            rows, w = parse_sales_csv(raw, codes, names)
            warnings += w
        else:  # unstructured report email -> extract rows, then map deterministically
            ex = await ctx.llm_json(tier="extract", schema=ReportRows,
                                    system="Extract per-dish daily sales rows from this food-aggregator report.",
                                    prompt=raw.decode("utf-8", "replace")[:15000])
            buf = io.StringIO()
            wr = csv.writer(buf)
            wr.writerow(["date", "dish", "qty", "channel"])
            for r in ex.rows:
                wr.writerow([r.date, r.dish, r.qty, r.channel])
            rows, w = parse_sales_csv(buf.getvalue().encode(), codes, names)
            warnings += w
        async with ctx.tx() as conn:
            parsed += await upsert_sales(conn, ctx.org_id, ctx.venture_id, rows, "email")
            await conn.execute(text("UPDATE documents SET meta = meta || CAST(:m AS jsonb) WHERE id = :id"),
                               {"m": json.dumps({"parsed": True, "rows": len(rows)}), "id": rep.id})
    target = _target(state)
    async with ctx.tx() as conn:
        last = (await conn.execute(text("SELECT max(sale_date) FROM sales_daily WHERE venture_id = :v"),
                                   {"v": ctx.venture_id})).scalar()
    stale = last is None or last < target - timedelta(days=2)
    if stale:
        warnings.append(f"latest sales data is {last or 'missing'}; upload yesterday's CSV for a better forecast")
    return Goto("forecast", update={"target_date": target.isoformat(), "warnings": warnings[:20],
                                    "summary": {"target_date": target.isoformat(), "data_stale": stale}},
                note=f"{len(reports)} report(s), {parsed} sales row(s) ingested" + ("; data stale" if stale else ""))


# --------------------------------------------------------------------- forecast --
@wf.step("forecast", agent="forecasting")
async def forecast(ctx: RunContext, state: dict) -> Goto | Finish:
    cfg = {**DEFAULTS, **(await ctx.settings())}
    target = date.fromisoformat(state["target_date"])
    async with ctx.tx() as conn:
        dishes = (await conn.execute(text("SELECT id, code, name FROM dishes WHERE venture_id = :v AND active"),
                                     {"v": ctx.venture_id})).all()
        rows = (await conn.execute(text(
            "SELECT dish_id, sale_date, sum(qty) AS qty FROM sales_daily WHERE venture_id = :v"
            " AND sale_date >= :from AND sale_date < :to GROUP BY dish_id, sale_date ORDER BY sale_date"),
            {"v": ctx.venture_id, "from": target - timedelta(days=int(cfg["history_days"])), "to": target})).all()
    if not dishes:
        return Finish("no_reference_data", note="no dishes configured — set up recipes, vendors and stock first")
    series: dict[str, list[dict]] = {str(d.id): [] for d in dishes}
    for r in rows:
        series.setdefault(str(r.dish_id), []).append({"date": r.sale_date.isoformat(), "qty": float(r.qty)})
    out = await ctx.invoke("sandbox.forecast", {"target_date": target.isoformat(), "series": series})
    return Goto("adjust", update={"model": out["forecasts"],
                                  "dish_names": {str(d.id): d.name for d in dishes},
                                  "dish_codes": {str(d.id): d.code for d in dishes}},
                note=f"forecast {len(out['forecasts'])} dishes, {out['portions_total']:.0f} portions")


@wf.step("adjust", agent="forecasting")
async def adjust(ctx: RunContext, state: dict) -> Goto:
    target = date.fromisoformat(state["target_date"])
    async with ctx.tx() as conn:
        events = (await conn.execute(text(
            "SELECT name, multiplier, note FROM calendar_events WHERE venture_id = :v AND event_date = :d"),
            {"v": ctx.venture_id, "d": target})).all()
    multiplier, reasons = Decimal("1"), []
    for ev in events:
        if ev.multiplier is not None:
            m = Decimal(ev.multiplier)
            reasons.append({"event": ev.name, "multiplier": str(m), "source": "configured"})
        else:
            try:
                where = (await ctx.business()).where
                imp = await ctx.llm_json(
                    tier="fast", schema=EventImpact,
                    system=("You estimate how an Indian calendar event changes food-delivery demand for a cloud "
                            f"kitchen in {where} versus a normal day of the same weekday. Be conservative."),
                    prompt=f"Event on {target:%A %d %B %Y}: {ev.name}. {ev.note or ''}")
                m = Decimal(str(round(min(MULT_MAX, max(MULT_MIN, imp.multiplier)), 2)))
                reasons.append({"event": ev.name, "multiplier": str(m), "source": "model", "reason": imp.reason[:200]})
            except Exception:
                m = Decimal("1")
                reasons.append({"event": ev.name, "multiplier": "1", "source": "fallback"})
        multiplier *= m
    multiplier = min(Decimal(MULT_MAX), max(Decimal(MULT_MIN), multiplier)).quantize(Decimal("0.01"))

    final: dict[str, float] = {}
    async with ctx.tx() as conn:
        for dish_id, f in state["model"].items():
            qty = math.ceil(Decimal(str(f["qty"])) * multiplier) if f["qty"] > 0 else 0
            final[dish_id] = qty
            await conn.execute(text(
                "INSERT INTO forecasts (org_id, venture_id, run_id, target_date, dish_id, model_qty, lo, hi, method,"
                " mape_backtest, event_multiplier, final_qty) VALUES (:o, :v, :r, :t, :d, :q, :lo, :hi, :m, :mape,"
                " :em, :fq) ON CONFLICT (run_id, dish_id) DO UPDATE SET final_qty = EXCLUDED.final_qty,"
                " event_multiplier = EXCLUDED.event_multiplier"),
                {"o": ctx.org_id, "v": ctx.venture_id, "r": ctx.run_id, "t": target, "d": uuid.UUID(dish_id),
                 "q": f["qty"], "lo": f["lo"], "hi": f["hi"], "m": f["method"], "mape": f["mape_backtest"],
                 "em": multiplier, "fq": qty})
    return Goto("plan", update={"final": final, "multiplier": str(multiplier), "events": reasons},
                note=(f"events: {', '.join(r['event'] for r in reasons)} (×{multiplier})" if reasons
                      else "no calendar events"))


# ------------------------------------------------------------------------- plan --
@wf.step("plan", agent="operations")
async def plan(ctx: RunContext, state: dict) -> Goto:
    cfg = {**DEFAULTS, **(await ctx.settings())}
    target = date.fromisoformat(state["target_date"])
    async with ctx.tx() as conn:
        rec = (await conn.execute(text(
            "SELECT r.dish_id, i.id AS ingredient_id, r.qty_per_portion, r.wastage_pct FROM recipe_items r"
            " JOIN ingredients i ON i.id = r.ingredient_id WHERE r.venture_id = :v"), {"v": ctx.venture_id})).all()
        stock = (await conn.execute(text(
            "SELECT DISTINCT ON (ingredient_id) ingredient_id, qty FROM stock_counts WHERE venture_id = :v"
            " ORDER BY ingredient_id, counted_at DESC"), {"v": ctx.venture_id})).all()
        supply = (await conn.execute(text(
            "SELECT DISTINCT ON (vi.ingredient_id) vi.ingredient_id, vi.vendor_id, vi.sku, vi.pack_size,"
            " vi.price_per_pack, vi.min_order_packs, i.unit FROM vendor_items vi"
            " JOIN vendors ve ON ve.id = vi.vendor_id AND ve.active JOIN ingredients i ON i.id = vi.ingredient_id"
            " WHERE vi.venture_id = :v ORDER BY vi.ingredient_id, vi.preferred DESC, vi.price_per_pack / vi.pack_size"),
            {"v": ctx.venture_id})).all()
        ingredients = {str(r.id): {"name": r.name, "unit": r.unit, "code": r.code} for r in (await conn.execute(
            text("SELECT id, name, unit, code FROM ingredients WHERE venture_id = :v"), {"v": ctx.venture_id})).all()}
        vendors = {str(r.id): {"name": r.name, "email": r.email, "code": r.code} for r in (await conn.execute(
            text("SELECT id, name, email, code FROM vendors WHERE venture_id = :v"), {"v": ctx.venture_id})).all()}
    recipes: dict[str, list] = {}
    for r in rec:
        recipes.setdefault(str(r.dish_id), []).append({"ingredient_id": str(r.ingredient_id),
                                                       "qty_per_portion": str(r.qty_per_portion),
                                                       "wastage_pct": str(r.wastage_pct)})
    payload = {
        "portions": state["final"], "recipes": recipes, "safety_stock_pct": cfg["safety_stock_pct"],
        "stock": {str(s.ingredient_id): float(s.qty) for s in stock},
        "supply": {str(s.ingredient_id): {"vendor_id": str(s.vendor_id), "sku": s.sku, "pack_size": str(s.pack_size),
                                          "price_per_pack": str(s.price_per_pack), "min_order_packs": s.min_order_packs,
                                          "unit": s.unit} for s in supply},
    }
    bom = await ctx.invoke("sandbox.bom", payload)

    names, pos = state["dish_names"], []
    prep = {"dishes": [{"dish": names.get(d, d), "portions": q} for d, q in sorted(state["final"].items(),
                                                                                   key=lambda kv: -kv[1]) if q],
            "ingredients": [{"ingredient": ingredients.get(r["ingredient_id"], {}).get("name", r["ingredient_id"]),
                             "required": r["required"], "on_hand": r["on_hand"],
                             "unit": ingredients.get(r["ingredient_id"], {}).get("unit", "")}
                            for r in bom["requirements"]]}
    async with ctx.tx() as conn:
        await conn.execute(text(
            "INSERT INTO prep_lists (org_id, venture_id, run_id, target_date, items) VALUES (:o, :v, :r, :t,"
            " CAST(:i AS jsonb)) ON CONFLICT (run_id) DO UPDATE SET items = EXCLUDED.items"),
            {"o": ctx.org_id, "v": ctx.venture_id, "r": ctx.run_id, "t": target, "i": json.dumps(prep)})
        await conn.execute(text("DELETE FROM purchase_orders WHERE run_id = :r AND status = 'draft'"),
                           {"r": ctx.run_id})  # idempotent re-run of this step
        for po in bom["purchase_orders"]:
            v = vendors[po["vendor_id"]]
            lines = [{**li, "ingredient": ingredients[li["ingredient_id"]]["name"]} for li in po["lines"]]
            number = f"PO-{target:%Y%m%d}-{v['code'].upper()}"
            po_id = (await conn.execute(text(
                "INSERT INTO purchase_orders (org_id, venture_id, run_id, po_number, vendor_id, target_date, lines,"
                " total_inr) VALUES (:o, :v, :r, :n, :vid, :t, CAST(:l AS jsonb), :tot)"
                " ON CONFLICT (venture_id, po_number) DO UPDATE SET run_id = EXCLUDED.run_id, lines = EXCLUDED.lines,"
                " total_inr = EXCLUDED.total_inr, status = 'draft' RETURNING id"),
                {"o": ctx.org_id, "v": ctx.venture_id, "r": ctx.run_id, "n": number, "vid": uuid.UUID(po["vendor_id"]),
                 "t": target, "l": json.dumps(lines), "tot": po["total"]})).scalar_one()
            pos.append({"id": str(po_id), "number": number, "vendor_id": po["vendor_id"], "vendor": v["name"],
                        "email": v["email"], "total": po["total"], "lines": lines})
    warn = []
    if bom["unsourced_ingredients"]:
        warn.append(f"{len(bom['unsourced_ingredients'])} ingredient(s) short with no vendor configured")
    if bom["dishes_without_recipe"]:
        warn.append(f"{len(bom['dishes_without_recipe'])} forecast dish(es) have no recipe")
    return Goto("narrate", update={"pos": pos, "po_index": 0, "grand_total": bom["grand_total"],
                                   "warnings": state.get("warnings", []) + warn,
                                   "summary": {**state.get("summary", {}), "pos": len(pos),
                                               "po_total": bom["grand_total"]}},
                note=f"{len(pos)} PO(s), total {fmt_inr(bom['grand_total'])}")


@wf.step("narrate", agent="operations")
async def narrate(ctx: RunContext, state: dict) -> Goto:
    names, model = state["dish_names"], state["model"]
    diffs = []
    for d, q in state["final"].items():
        last = model[d].get("same_weekday_last_week")
        if last is not None and (q - last) != 0:
            diffs.append((abs(q - last), names.get(d, d), last, q))
    diffs.sort(reverse=True)
    facts = [f"Target date: {state['target_date']} ({date.fromisoformat(state['target_date']):%A})",
             f"Total portions forecast: {sum(state['final'].values())}",
             f"Event multiplier: x{state['multiplier']} " + ", ".join(e["event"] for e in state.get("events", [])),
             "Biggest changes vs same weekday last week: " +
             "; ".join(f"{n}: {int(a)} -> {int(b)}" for _, n, a, b in diffs[:5]),
             f"Purchase orders: {len(state['pos'])}, total {fmt_inr(state['grand_total'])}"]
    if state.get("warnings"):
        facts.append("Warnings: " + "; ".join(state["warnings"]))
    try:
        story = await ctx.llm_text(
            tier="fast", max_tokens=250,
            system=(f"{await ctx.brief()}\nWrite 3-4 plain sentences for the cloud-kitchen manager explaining why "
                    "tomorrow's plan differs from usual. Use ONLY the numbers given; do not calculate anything new."),
            prompt="\n".join(facts))
    except Exception:
        story = ". ".join(f.rstrip(".") for f in facts) + "."
    async with ctx.tx() as conn:
        await conn.execute(text("UPDATE prep_lists SET narrative = :n WHERE run_id = :r"),
                           {"n": story[:2000], "r": ctx.run_id})
    return Goto("po_gate", update={"narrative": story})


def po_email(po: dict[str, Any], target: str, kitchen: str) -> str:
    lines = [f"Purchase order {po['number']} — delivery for {target}", "", f"To: {po['vendor']}", "",
             "Item | SKU | Packs | Pack size | Rate | Amount", "-" * 60]
    for li in po["lines"]:
        lines.append(f"{li['ingredient']} | {li.get('sku') or '-'} | {li['packs']} | {li['pack_size']} {li['unit']} | "
                     f"{fmt_inr(li['price_per_pack'])} | {fmt_inr(li['line_total'])}")
    lines += ["-" * 60, f"Total: {fmt_inr(po['total'])}", "",
              "Please confirm by reply and deliver before 9:00 AM.", "", f"— {kitchen}"]
    return "\n".join(lines)


@wf.step("po_gate", agent="operations")
async def po_gate(ctx: RunContext, state: dict) -> Interrupt | Goto | Finish:
    i, pos = state["po_index"], state["pos"]
    if i >= len(pos):
        sent = sum(1 for p in pos if p.get("result") == "sent")
        return Finish("completed", update={"summary": {**state.get("summary", {}), "pos_sent": sent}},
                      note=f"{sent}/{len(pos)} PO(s) sent")
    po = pos[i]
    if not po.get("email"):
        pos[i]["result"] = "no_vendor_email"
        return Goto("po_gate", update={"po_index": i + 1, "pos": pos},
                    note=f"{po['number']}: vendor has no email; send manually")
    kitchen = (await ctx.settings()).get("kitchen_name", "Kitchen operations")
    return Interrupt(
        ApprovalRequest(
            agent="operations", action="gmail.send", key="po_decision",
            required_roles=("kitchen_manager", "venture_admin"), expires_in_hours=14,
            title=f"Send {po['number']} to {po['vendor']} ({fmt_inr(po['total'])})",
            summary=(state.get("narrative", "")[:600] + f"\n\n{len(po['lines'])} line(s). Quantities and totals were "
                     "computed from the forecast, recipes and current stock."),
            payload={"to": po["email"], "subject": f"{po['number']} — delivery {state['target_date']}",
                     "body": po_email(po, state["target_date"], kitchen), "po_id": po["id"]}),
        resume="send_po", on_reject="po_rejected")


@wf.step("send_po", agent="operations")
async def send_po(ctx: RunContext, state: dict) -> Goto:
    d, i, pos = state["po_decision"], state["po_index"], state["pos"]
    res = await ctx.invoke("gmail.send", approval_id=d["approval_id"])
    async with ctx.tx() as conn:
        await conn.execute(text("UPDATE purchase_orders SET status = 'sent', sent_at = now(), approval_id = :a"
                                " WHERE id = :id"), {"a": uuid.UUID(d["approval_id"]), "id": uuid.UUID(pos[i]["id"])})
    pos[i]["result"] = "sent"
    return Goto("po_gate", update={"po_index": i + 1, "pos": pos},
                note=f"{pos[i]['number']} {res.get('status')} via {res.get('transport')}")


@wf.step("po_rejected", agent="operations")
async def po_rejected(ctx: RunContext, state: dict) -> Goto:
    d, i, pos = state["po_decision"], state["po_index"], state["pos"]
    async with ctx.tx() as conn:
        await conn.execute(text("UPDATE purchase_orders SET status = 'rejected', approval_id = :a WHERE id = :id"),
                           {"a": uuid.UUID(d["approval_id"]), "id": uuid.UUID(pos[i]["id"])})
    pos[i]["result"] = d["status"]
    return Goto("po_gate", update={"po_index": i + 1, "pos": pos}, note=f"{pos[i]['number']} {d['status']}")
