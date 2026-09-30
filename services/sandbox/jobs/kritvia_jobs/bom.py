"""Recipe bill-of-materials x forecast -> ingredient requirements -> vendor POs.

All money in Decimal, rounded half-up to paise. Quantities are converted to
whole purchase packs (never fractional orders) and respect minimum order packs.
"""
from __future__ import annotations

import math
from decimal import ROUND_HALF_UP, Decimal

PAISE = Decimal("0.01")


def _d(x) -> Decimal:
    return Decimal(str(x))


def run(payload: dict) -> dict:
    portions: dict[str, float] = {k: float(v) for k, v in payload["portions"].items()}
    recipes: dict[str, list[dict]] = payload["recipes"]
    stock: dict[str, float] = {k: float(v) for k, v in (payload.get("stock") or {}).items()}
    supply: dict[str, dict] = payload.get("supply") or {}
    safety = _d(payload.get("safety_stock_pct", 10)) / 100

    required: dict[str, Decimal] = {}
    missing_recipes = []
    for dish, qty in portions.items():
        lines = recipes.get(dish)
        if not lines:
            if qty > 0:
                missing_recipes.append(dish)
            continue
        for line in lines:
            per = _d(line["qty_per_portion"]) * (1 + _d(line.get("wastage_pct", 0)) / 100)
            required[line["ingredient_id"]] = required.get(line["ingredient_id"], Decimal(0)) + per * _d(qty)

    requirements, pos, unsourced = [], {}, []
    for ing, req in sorted(required.items()):
        on_hand = _d(stock.get(ing, 0))
        need = req * (1 + safety) - on_hand
        row = {"ingredient_id": ing, "required": float(req.quantize(Decimal("0.001"))),
               "on_hand": float(on_hand), "to_buy": float(max(need, Decimal(0)).quantize(Decimal("0.001")))}
        requirements.append(row)
        if need <= 0:
            continue
        src = supply.get(ing)
        if not src:
            unsourced.append(ing)
            continue
        pack = _d(src["pack_size"])
        packs = max(math.ceil(need / pack), int(src.get("min_order_packs", 1)))
        price = _d(src["price_per_pack"])
        total = (price * packs).quantize(PAISE, ROUND_HALF_UP)
        po = pos.setdefault(src["vendor_id"], {"vendor_id": src["vendor_id"], "lines": [], "total": Decimal(0)})
        po["lines"].append({"ingredient_id": ing, "sku": src.get("sku"), "packs": packs,
                            "pack_size": float(pack), "unit": src.get("unit", ""),
                            "price_per_pack": str(price.quantize(PAISE)), "line_total": str(total)})
        po["total"] += total

    orders = []
    for po in pos.values():
        po["total"] = str(po["total"].quantize(PAISE, ROUND_HALF_UP))
        orders.append(po)
    grand = sum((_d(o["total"]) for o in orders), Decimal(0)).quantize(PAISE, ROUND_HALF_UP)
    return {"requirements": requirements, "purchase_orders": sorted(orders, key=lambda o: o["vendor_id"]),
            "grand_total": str(grand), "unsourced_ingredients": unsourced,
            "dishes_without_recipe": missing_recipes}
