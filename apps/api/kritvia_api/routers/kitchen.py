"""Cloud kitchen: reference data (dishes, ingredients, recipes, vendors, stock),
sales ingestion, calendar events, and the daily plan (forecast, prep list, POs)."""
from __future__ import annotations

import csv
import io
import uuid
from datetime import date, timedelta
from decimal import Decimal
from typing import Any, Literal

from fastapi import APIRouter, File, HTTPException, UploadFile, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.db.session import tenant_tx
from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.engine.runner import start_run
from kritvia_api.errors import raise_for_db
from kritvia_api.routers.knowledge import read_upload
from kritvia_api.workflows.common import today_ist
from kritvia_api.workflows.kitchen import dish_maps, parse_sales_csv, upsert_sales
from kritvia_api.services.quota import PlanRestricted

router = APIRouter(prefix="/ventures/{venture_id}/kitchen", tags=["kitchen"])

Code = Field(pattern=r"^[a-z0-9_-]{1,60}$")
Unit = Literal["kg", "g", "l", "ml", "pcs", "dozen", "pack"]


class Dish(BaseModel):
    code: str = Code
    name: str = Field(min_length=1, max_length=200)
    price_inr: Decimal | None = Field(default=None, ge=0)
    active: bool = True


class Ingredient(BaseModel):
    code: str = Code
    name: str = Field(min_length=1, max_length=200)
    unit: Unit


class Vendor(BaseModel):
    code: str = Code
    name: str = Field(min_length=1, max_length=200)
    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=20)
    lead_days: int = Field(default=1, ge=0, le=30)
    active: bool = True


class RecipeLine(BaseModel):
    ingredient_code: str = Code
    qty_per_portion: Decimal = Field(gt=0)
    wastage_pct: Decimal = Field(default=Decimal(0), ge=0, le=100)


class VendorItem(BaseModel):
    vendor_code: str = Code
    ingredient_code: str = Code
    sku: str | None = Field(default=None, max_length=80)
    pack_size: Decimal = Field(gt=0)
    price_per_pack: Decimal = Field(ge=0)
    min_order_packs: int = Field(default=1, ge=1)
    preferred: bool = True


ENTITY_MODELS = {"dishes": Dish, "ingredients": Ingredient, "vendors": Vendor}
ENTITY_COLS = {"dishes": ["code", "name", "price_inr", "active"], "ingredients": ["code", "name", "unit"],
               "vendors": ["code", "name", "email", "phone", "lead_days", "active"]}


async def _write_access(db, venture_id: uuid.UUID) -> uuid.UUID:
    org = await venture_org(db, venture_id)
    ok = (await db.execute(text("SELECT :v = ANY (private.writable_ventures())"), {"v": venture_id})).scalar()
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "venture not found")
    return org


async def _upsert(db, org, venture_id, entity: str, items: list[BaseModel]) -> int:
    cols = ENTITY_COLS[entity]
    sets = ", ".join(f"{c} = EXCLUDED.{c}" for c in cols if c != "code")
    for it in items:
        await db.execute(text(
            f"INSERT INTO {entity} (org_id, venture_id, {', '.join(cols)}) VALUES (:o, :v, {', '.join(':' + c for c in cols)})"
            f" ON CONFLICT (venture_id, code) DO UPDATE SET {sets}"),
            {"o": org, "v": venture_id, **it.model_dump(include=set(cols))})
    return len(items)


@router.get("/ref/{entity}", response_model=list[dict[str, Any]])
async def list_entity(venture_id: uuid.UUID, entity: Literal["dishes", "ingredients", "vendors"],
                      db: TenantDB) -> list[dict[str, Any]]:
    cols = ", ".join(["id"] + ENTITY_COLS[entity])
    rows = (await db.execute(text(f"SELECT {cols} FROM {entity} WHERE venture_id = :v ORDER BY code"),
                             {"v": venture_id})).all()
    return [dict(r._mapping) for r in rows]


class EntityBatch(BaseModel):
    items: list[dict[str, Any]] = Field(max_length=2000)


class ImportOut(BaseModel):
    upserted: int
    errors: list[str]


def _validate(entity: str, raw: list[dict[str, Any]]) -> tuple[list[BaseModel], list[str]]:
    model, ok, errors = ENTITY_MODELS[entity], [], []
    for i, item in enumerate(raw, start=1):
        clean = {k: (v if v != "" else None) for k, v in item.items() if k}
        if "active" in clean and isinstance(clean["active"], str):
            clean["active"] = clean["active"].strip().lower() not in ("false", "0", "no", "n")
        clean = {k: v for k, v in clean.items() if v is not None}
        try:
            ok.append(model(**clean))
        except Exception as exc:
            errors.append(f"row {i}: {str(exc).splitlines()[0][:160]}")
    return ok, errors


@router.put("/ref/{entity}", response_model=ImportOut)
async def upsert_entity(venture_id: uuid.UUID, entity: Literal["dishes", "ingredients", "vendors"],
                        body: EntityBatch, db: TenantDB) -> ImportOut:
    org = await _write_access(db, venture_id)
    items, errors = _validate(entity, body.items)
    try:
        async with db.begin_nested():
            n = await _upsert(db, org, venture_id, entity, items)
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    return ImportOut(upserted=n, errors=errors)


def _csv_rows(data: bytes) -> list[dict[str, Any]]:
    reader = csv.DictReader(io.StringIO(data.decode("utf-8-sig", "replace")))
    return [{(k or "").strip().lower(): (v or "").strip() for k, v in row.items()} for row in reader]


@router.post("/import/{entity}", response_model=ImportOut)
async def import_csv(venture_id: uuid.UUID,
                     entity: Literal["dishes", "ingredients", "vendors", "recipes", "vendor_items"],
                     db: TenantDB, file: UploadFile = File(...)) -> ImportOut:
    """CSV import. Columns: dishes(code,name,price_inr) ingredients(code,name,unit)
    vendors(code,name,email,phone,lead_days) recipes(dish_code,ingredient_code,qty_per_portion,wastage_pct)
    vendor_items(vendor_code,ingredient_code,sku,pack_size,price_per_pack,min_order_packs)."""
    org = await _write_access(db, venture_id)
    rows = _csv_rows(await read_upload(file))
    try:
        async with db.begin_nested():
            if entity in ENTITY_MODELS:
                items, errors = _validate(entity, rows)
                return ImportOut(upserted=await _upsert(db, org, venture_id, entity, items), errors=errors)
            if entity == "recipes":
                by_dish: dict[str, list[RecipeLine]] = {}
                errors = []
                for i, r in enumerate(rows, start=1):
                    try:
                        by_dish.setdefault(r["dish_code"], []).append(RecipeLine(
                            ingredient_code=r["ingredient_code"], qty_per_portion=r["qty_per_portion"],
                            wastage_pct=r.get("wastage_pct") or 0))
                    except Exception as exc:
                        errors.append(f"row {i}: {str(exc).splitlines()[0][:160]}")
                n, errs = await _put_recipes(db, org, venture_id, by_dish)
                return ImportOut(upserted=n, errors=errors + errs)
            items, errors = [], []
            for i, r in enumerate(rows, start=1):
                try:
                    items.append(VendorItem(**{k: v for k, v in r.items() if v != ""}))
                except Exception as exc:
                    errors.append(f"row {i}: {str(exc).splitlines()[0][:160]}")
            n, errs = await _put_vendor_items(db, org, venture_id, items)
            return ImportOut(upserted=n, errors=errors + errs)
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")


async def _ids(db, venture_id, table: str) -> dict[str, uuid.UUID]:
    return {r.code: r.id for r in (await db.execute(text(f"SELECT id, code FROM {table} WHERE venture_id = :v"),
                                                    {"v": venture_id})).all()}


async def _put_recipes(db, org, venture_id, recipes: dict[str, list[RecipeLine]]) -> tuple[int, list[str]]:
    dishes, ings = await _ids(db, venture_id, "dishes"), await _ids(db, venture_id, "ingredients")
    n, errors = 0, []
    for dish_code, lines in recipes.items():
        if dish_code not in dishes:
            errors.append(f"unknown dish {dish_code}")
            continue
        await db.execute(text("DELETE FROM recipe_items WHERE dish_id = :d"), {"d": dishes[dish_code]})
        for line in lines:
            if line.ingredient_code not in ings:
                errors.append(f"{dish_code}: unknown ingredient {line.ingredient_code}")
                continue
            await db.execute(text(
                "INSERT INTO recipe_items (org_id, venture_id, dish_id, ingredient_id, qty_per_portion, wastage_pct)"
                " VALUES (:o, :v, :d, :i, :q, :w) ON CONFLICT (dish_id, ingredient_id)"
                " DO UPDATE SET qty_per_portion = EXCLUDED.qty_per_portion, wastage_pct = EXCLUDED.wastage_pct"),
                {"o": org, "v": venture_id, "d": dishes[dish_code], "i": ings[line.ingredient_code],
                 "q": line.qty_per_portion, "w": line.wastage_pct})
            n += 1
    return n, errors


async def _put_vendor_items(db, org, venture_id, items: list[VendorItem]) -> tuple[int, list[str]]:
    vendors, ings = await _ids(db, venture_id, "vendors"), await _ids(db, venture_id, "ingredients")
    n, errors = 0, []
    for it in items:
        if it.vendor_code not in vendors or it.ingredient_code not in ings:
            errors.append(f"unknown vendor/ingredient {it.vendor_code}/{it.ingredient_code}")
            continue
        await db.execute(text(
            "INSERT INTO vendor_items (org_id, venture_id, vendor_id, ingredient_id, sku, pack_size, price_per_pack,"
            " min_order_packs, preferred) VALUES (:o, :v, :vid, :i, :sku, :ps, :pp, :mo, :pref)"
            " ON CONFLICT (vendor_id, ingredient_id) DO UPDATE SET sku = EXCLUDED.sku, pack_size = EXCLUDED.pack_size,"
            " price_per_pack = EXCLUDED.price_per_pack, min_order_packs = EXCLUDED.min_order_packs,"
            " preferred = EXCLUDED.preferred"),
            {"o": org, "v": venture_id, "vid": vendors[it.vendor_code], "i": ings[it.ingredient_code], "sku": it.sku,
             "ps": it.pack_size, "pp": it.price_per_pack, "mo": it.min_order_packs, "pref": it.preferred})
        n += 1
    return n, errors


class RecipesIn(BaseModel):
    recipes: dict[str, list[RecipeLine]] = Field(description="dish_code -> lines (replaces that dish's recipe)")


@router.put("/recipes", response_model=ImportOut)
async def put_recipes(venture_id: uuid.UUID, body: RecipesIn, db: TenantDB) -> ImportOut:
    org = await _write_access(db, venture_id)
    try:
        async with db.begin_nested():
            n, errors = await _put_recipes(db, org, venture_id, body.recipes)
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    return ImportOut(upserted=n, errors=errors)


@router.get("/recipes", response_model=dict[str, list[dict[str, Any]]])
async def get_recipes(venture_id: uuid.UUID, db: TenantDB) -> dict[str, list[dict[str, Any]]]:
    rows = (await db.execute(text(
        "SELECT d.code AS dish_code, i.code AS ingredient_code, i.unit, r.qty_per_portion, r.wastage_pct"
        " FROM recipe_items r JOIN dishes d ON d.id = r.dish_id JOIN ingredients i ON i.id = r.ingredient_id"
        " WHERE r.venture_id = :v ORDER BY d.code, i.code"), {"v": venture_id})).all()
    out: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        out.setdefault(r.dish_code, []).append({k: v for k, v in r._mapping.items() if k != "dish_code"})
    return out


class VendorItemsIn(BaseModel):
    items: list[VendorItem] = Field(max_length=2000)


@router.put("/vendor-items", response_model=ImportOut)
async def put_vendor_items(venture_id: uuid.UUID, body: VendorItemsIn, db: TenantDB) -> ImportOut:
    org = await _write_access(db, venture_id)
    try:
        async with db.begin_nested():
            n, errors = await _put_vendor_items(db, org, venture_id, body.items)
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    return ImportOut(upserted=n, errors=errors)


@router.get("/vendor-items", response_model=list[dict[str, Any]])
async def get_vendor_items(venture_id: uuid.UUID, db: TenantDB) -> list[dict[str, Any]]:
    rows = (await db.execute(text(
        "SELECT ve.code AS vendor_code, i.code AS ingredient_code, vi.sku, vi.pack_size, i.unit, vi.price_per_pack,"
        " vi.min_order_packs, vi.preferred FROM vendor_items vi JOIN vendors ve ON ve.id = vi.vendor_id"
        " JOIN ingredients i ON i.id = vi.ingredient_id WHERE vi.venture_id = :v ORDER BY i.code, ve.code"),
        {"v": venture_id})).all()
    return [dict(r._mapping) for r in rows]


# ------------------------------------------------------------------ stock --
class StockCount(BaseModel):
    ingredient_code: str = Code
    qty: Decimal = Field(ge=0)


class StockIn(BaseModel):
    counts: list[StockCount] = Field(max_length=2000)


@router.post("/stock", response_model=ImportOut)
async def post_stock(venture_id: uuid.UUID, body: StockIn, user_id: UserId, db: TenantDB) -> ImportOut:
    org = await _write_access(db, venture_id)
    ings = await _ids(db, venture_id, "ingredients")
    n, errors = 0, []
    try:
        async with db.begin_nested():
            for c in body.counts:
                if c.ingredient_code not in ings:
                    errors.append(f"unknown ingredient {c.ingredient_code}")
                    continue
                await db.execute(text("INSERT INTO stock_counts (org_id, venture_id, ingredient_id, qty, counted_by)"
                                      " VALUES (:o, :v, :i, :q, :u)"),
                                 {"o": org, "v": venture_id, "i": ings[c.ingredient_code], "q": c.qty, "u": user_id})
                n += 1
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    return ImportOut(upserted=n, errors=errors)


@router.get("/stock", response_model=list[dict[str, Any]])
async def get_stock(venture_id: uuid.UUID, db: TenantDB) -> list[dict[str, Any]]:
    rows = (await db.execute(text(
        "SELECT i.code AS ingredient_code, i.name, i.unit, s.qty, s.counted_at FROM ingredients i"
        " LEFT JOIN LATERAL (SELECT qty, counted_at FROM stock_counts sc WHERE sc.ingredient_id = i.id"
        "   ORDER BY counted_at DESC LIMIT 1) s ON true WHERE i.venture_id = :v ORDER BY i.code"),
        {"v": venture_id})).all()
    return [dict(r._mapping) for r in rows]


# ------------------------------------------------------------------ sales --
@router.post("/sales/csv", response_model=ImportOut)
async def upload_sales(venture_id: uuid.UUID, db: TenantDB, file: UploadFile = File(...)) -> ImportOut:
    """Aggregator export or template CSV: date, dish (code or name), qty[, channel, revenue]."""
    org = await _write_access(db, venture_id)
    codes, names = await dish_maps(db, venture_id)
    rows, warnings = parse_sales_csv(await read_upload(file), codes, names)
    try:
        async with db.begin_nested():
            n = await upsert_sales(db, org, venture_id, rows, "csv")
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    return ImportOut(upserted=n, errors=warnings)


@router.get("/sales", response_model=list[dict[str, Any]])
async def get_sales(venture_id: uuid.UUID, db: TenantDB, days: int = 30) -> list[dict[str, Any]]:
    rows = (await db.execute(text(
        "SELECT s.sale_date, d.code AS dish_code, d.name, sum(s.qty) AS qty, sum(s.revenue_inr) AS revenue_inr"
        " FROM sales_daily s JOIN dishes d ON d.id = s.dish_id WHERE s.venture_id = :v AND s.sale_date >= :f"
        " GROUP BY s.sale_date, d.code, d.name ORDER BY s.sale_date, d.code"),
        {"v": venture_id, "f": today_ist() - timedelta(days=min(max(days, 1), 365))})).all()
    return [dict(r._mapping) for r in rows]


# ----------------------------------------------------------------- events --
class EventIn(BaseModel):
    event_date: date
    name: str = Field(min_length=1, max_length=200)
    multiplier: Decimal | None = Field(default=None, ge=Decimal("0.2"), le=3)
    note: str | None = Field(default=None, max_length=500)


@router.get("/events", response_model=list[dict[str, Any]])
async def list_events(venture_id: uuid.UUID, db: TenantDB) -> list[dict[str, Any]]:
    rows = (await db.execute(text("SELECT id, event_date, name, multiplier, note FROM calendar_events"
                                  " WHERE venture_id = :v AND event_date >= :f ORDER BY event_date"),
                             {"v": venture_id, "f": today_ist() - timedelta(days=30)})).all()
    return [dict(r._mapping) for r in rows]


@router.post("/events", response_model=dict[str, Any], status_code=201)
async def add_event(venture_id: uuid.UUID, body: EventIn, db: TenantDB) -> dict[str, Any]:
    org = await _write_access(db, venture_id)
    try:
        async with db.begin_nested():
            row = (await db.execute(text(
                "INSERT INTO calendar_events (org_id, venture_id, event_date, name, multiplier, note)"
                " VALUES (:o, :v, :d, :n, :m, :note) RETURNING id, event_date, name, multiplier, note"),
                {"o": org, "v": venture_id, "d": body.event_date, "n": body.name, "m": body.multiplier,
                 "note": body.note})).first()
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    return dict(row._mapping)


@router.delete("/events/{event_id}", status_code=204)
async def delete_event(venture_id: uuid.UUID, event_id: uuid.UUID, db: TenantDB) -> None:
    try:
        async with db.begin_nested():
            res = await db.execute(text("DELETE FROM calendar_events WHERE venture_id = :v AND id = :id"),
                                   {"v": venture_id, "id": event_id})
    except DBAPIError as exc:
        raise_for_db(exc, "event not found")
    if res.rowcount == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "event not found")


# ------------------------------------------------------------ daily plan --
class KitchenRunIn(BaseModel):
    target_date: date | None = None


class StartedOut(BaseModel):
    run_id: uuid.UUID


@router.post("/run", response_model=StartedOut, status_code=202)
async def run_now(venture_id: uuid.UUID, body: KitchenRunIn, user_id: UserId, svc: Svc) -> StartedOut:
    target = body.target_date or (today_ist() + timedelta(days=1))
    try:
        run_id = await start_run(svc, actor_user_id=user_id, venture_id=venture_id, workflow="kitchen_daily",
                                 input={"target_date": target.isoformat()}, title=f"Plan for {target:%a %d %b}")
    except LookupError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "venture not found") from None
    except ValueError as exc:
        raise HTTPException(402 if isinstance(exc, PlanRestricted) else 422, str(exc)) from None
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    return StartedOut(run_id=run_id)


class PlanOut(BaseModel):
    target_date: date
    run_id: uuid.UUID | None
    forecasts: list[dict[str, Any]]
    prep: dict[str, Any] | None
    narrative: str | None
    purchase_orders: list[dict[str, Any]]


@router.get("/plan", response_model=PlanOut)
async def get_plan(venture_id: uuid.UUID, db: TenantDB, target_date: date | None = None) -> PlanOut:
    await venture_org(db, venture_id)
    target = target_date or (today_ist() + timedelta(days=1))
    run = (await db.execute(text("SELECT run_id FROM prep_lists WHERE venture_id = :v AND target_date = :t"
                                 " ORDER BY created_at DESC LIMIT 1"), {"v": venture_id, "t": target})).first()
    run_id = run.run_id if run else None
    fc, prep, pos = [], None, []
    if run_id:
        fc = [dict(r._mapping) for r in (await db.execute(text(
            "SELECT d.code AS dish_code, d.name, f.model_qty, f.lo, f.hi, f.method, f.mape_backtest,"
            " f.event_multiplier, f.final_qty FROM forecasts f JOIN dishes d ON d.id = f.dish_id"
            " WHERE f.run_id = :r ORDER BY f.final_qty DESC"), {"r": run_id})).all()]
        p = (await db.execute(text("SELECT items, narrative FROM prep_lists WHERE run_id = :r"), {"r": run_id})).first()
        prep = {"items": p.items, "narrative": p.narrative} if p else None
        pos = [dict(r._mapping) for r in (await db.execute(text(
            "SELECT po.id, po.po_number, ve.name AS vendor, ve.email AS vendor_email, po.lines, po.total_inr, po.status,"
            " po.sent_at, po.approval_id FROM purchase_orders po JOIN vendors ve ON ve.id = po.vendor_id"
            " WHERE po.venture_id = :v AND po.target_date = :t ORDER BY po.po_number"),
            {"v": venture_id, "t": target})).all()]
    return PlanOut(target_date=target, run_id=run_id, forecasts=fc, prep=(prep or {}).get("items"),
                   narrative=(prep or {}).get("narrative"), purchase_orders=pos)


class AccuracyOut(BaseModel):
    days: int
    overall_mape: float | None
    dishes: list[dict[str, Any]]


@router.get("/accuracy", response_model=AccuracyOut)
async def accuracy(venture_id: uuid.UUID, db: TenantDB, days: int = 14) -> AccuracyOut:
    """Forecast error (MAPE) per dish over the last N days: latest forecast per date vs actual sales."""
    await venture_org(db, venture_id)
    days = min(max(days, 1), 90)
    rows = (await db.execute(text(
        "WITH latest AS (SELECT DISTINCT ON (f.target_date, f.dish_id) f.target_date, f.dish_id, f.final_qty"
        "   FROM forecasts f WHERE f.venture_id = :v AND f.target_date >= :f AND f.target_date < :t"
        "   ORDER BY f.target_date, f.dish_id, f.created_at DESC),"
        " actual AS (SELECT sale_date, dish_id, sum(qty) AS qty FROM sales_daily WHERE venture_id = :v"
        "   GROUP BY sale_date, dish_id)"
        " SELECT d.code, d.name, count(*) AS n, avg(abs(l.final_qty - a.qty) / a.qty) * 100 AS mape,"
        " sum(l.final_qty) AS forecast_total, sum(a.qty) AS actual_total"
        " FROM latest l JOIN actual a ON a.sale_date = l.target_date AND a.dish_id = l.dish_id AND a.qty > 0"
        " JOIN dishes d ON d.id = l.dish_id GROUP BY d.code, d.name ORDER BY mape DESC"),
        {"v": venture_id, "f": today_ist() - timedelta(days=days), "t": today_ist() + timedelta(days=1)})).all()
    dishes = [{"dish_code": r.code, "name": r.name, "days": r.n, "mape": round(float(r.mape), 1),
               "forecast_total": float(r.forecast_total), "actual_total": float(r.actual_total)} for r in rows]
    total_n = sum(d["days"] for d in dishes)
    overall = round(sum(d["mape"] * d["days"] for d in dishes) / total_n, 1) if total_n else None
    return AccuracyOut(days=days, overall_mape=overall, dishes=dishes)

