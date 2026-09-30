"""Seed a demo workspace through the public API (idempotent enough to re-run on a fresh DB).

Creates the owner, the three ventures, a Sitelytc rate card, a Truhome checklist and
application, kitchen reference data with 8 weeks of sales, and runs tomorrow's kitchen
plan so the approval inbox has real purchase orders to review.
"""
from __future__ import annotations

import asyncio
import os
from datetime import date, timedelta

import httpx

from kritvia_api.cli import bootstrap
from kritvia_api.db.session import dispose_engine

API = os.environ.get("KRITVIA_API_URL", "http://localhost:8000")
EMAIL, PASSWORD = "demo@example.com", "kritvia-demo-2026"


async def main() -> None:
    ids = await bootstrap(EMAIL, "Demo Owner", "Demo Group", "demo-group", PASSWORD)
    await dispose_engine()
    site, tru, kit = ids["ventures"]["sitelytc"], ids["ventures"]["truhome"], ids["ventures"]["kitchen"]
    async with httpx.AsyncClient(base_url=API, timeout=120) as c:
        tok = (await c.post("/auth/login", json={"email": EMAIL, "password": PASSWORD})).json()["access_token"]
        c.headers["Authorization"] = f"Bearer {tok}"

        async def ok(r: httpx.Response) -> dict:
            if r.status_code >= 400:
                raise SystemExit(f"{r.request.method} {r.request.url.path}: {r.status_code} {r.text[:300]}")
            return r.json() if r.content else {}

        await ok(await c.put(f"/ventures/{site}/rate-card", json={"items": [
            {"code": "web_nextjs", "name": "Next.js website (up to 5 pages)", "unit": "project", "rate_inr": "150000"},
            {"code": "page_extra", "name": "Additional page", "unit": "page", "rate_inr": "8000"},
            {"code": "ai_workflow", "name": "AI automation workflow (Kritvia AIBOS)", "unit": "workflow",
             "rate_inr": "60000"},
            {"code": "vapt_web", "name": "Web application VAPT", "unit": "assessment", "rate_inr": "90000"},
        ]}))
        await ok(await c.post(f"/ventures/{site}/notes", json={
            "title": "Proposal — Zenith Dental (accepted)", "kind": "proposal",
            "text": "Next.js clinic website with online booking, WhatsApp reminders and an AI receptionist. "
                    "Eight weeks. Accepted and delivered in May."}))

        template = await ok(await c.get("/checklists/template"))
        await ok(await c.put(f"/ventures/{tru}/checklists/home_loan", json=template))
        await ok(await c.post(f"/ventures/{tru}/loan-applications", json={
            "loan_type": "home_loan", "amount_inr": "4500000",
            "applicant": {"name": "Ravi Sharma (demo)", "email": "ravi.demo@example.com"},
            "consent": {"notice_version": "2026-09", "channel": "paper"}}))

        await ok(await c.put(f"/ventures/{kit}/kitchen/ref/dishes", json={"items": [
            {"code": "paneer-tikka", "name": "Paneer Tikka", "price_inr": "249"},
            {"code": "dal-makhani", "name": "Dal Makhani", "price_inr": "199"},
            {"code": "veg-biryani", "name": "Veg Biryani", "price_inr": "229"}]}))
        await ok(await c.put(f"/ventures/{kit}/kitchen/ref/ingredients", json={"items": [
            {"code": "paneer", "name": "Paneer", "unit": "kg"}, {"code": "rice", "name": "Basmati rice", "unit": "kg"},
            {"code": "cream", "name": "Fresh cream", "unit": "l"}, {"code": "urad", "name": "Urad dal", "unit": "kg"}]}))
        await ok(await c.put(f"/ventures/{kit}/kitchen/ref/vendors", json={"items": [
            {"code": "fresh_dairy", "name": "Fresh Dairy Co (demo)", "email": "orders@dairy.example.com"},
            {"code": "azadpur", "name": "Azadpur Mandi Traders (demo)", "email": "sales@azadpur.example.com"}]}))
        await ok(await c.put(f"/ventures/{kit}/kitchen/recipes", json={"recipes": {
            "paneer-tikka": [{"ingredient_code": "paneer", "qty_per_portion": "0.15", "wastage_pct": "5"}],
            "dal-makhani": [{"ingredient_code": "urad", "qty_per_portion": "0.08"},
                            {"ingredient_code": "cream", "qty_per_portion": "0.02"}],
            "veg-biryani": [{"ingredient_code": "rice", "qty_per_portion": "0.12"}]}}))
        await ok(await c.put(f"/ventures/{kit}/kitchen/vendor-items", json={"items": [
            {"vendor_code": "fresh_dairy", "ingredient_code": "paneer", "sku": "PN-1KG", "pack_size": "1",
             "price_per_pack": "380"},
            {"vendor_code": "fresh_dairy", "ingredient_code": "cream", "sku": "CR-1L", "pack_size": "1",
             "price_per_pack": "210"},
            {"vendor_code": "azadpur", "ingredient_code": "rice", "sku": "BAS-5", "pack_size": "5",
             "price_per_pack": "450"},
            {"vendor_code": "azadpur", "ingredient_code": "urad", "sku": "UD-5KG", "pack_size": "5",
             "price_per_pack": "650"}]}))
        await ok(await c.post(f"/ventures/{kit}/kitchen/stock", json={"counts": [
            {"ingredient_code": "paneer", "qty": "4"}, {"ingredient_code": "rice", "qty": "12.5"},
            {"ingredient_code": "cream", "qty": "0"}, {"ingredient_code": "urad", "qty": "0"}]}))
        tomorrow = date.today() + timedelta(days=1)
        rows = ["date,dish,qty"]
        for i in range(56, 0, -1):
            d = tomorrow - timedelta(days=i)
            wk = d.weekday() >= 5
            rows += [f"{d},paneer-tikka,{48 if wk else 36}", f"{d},dal-makhani,{26 if wk else 22}",
                     f"{d},veg-biryani,{22 if wk else 18}"]
        await ok(await c.post(f"/ventures/{kit}/kitchen/sales/csv",
                              files={"file": ("sales.csv", "\n".join(rows).encode(), "text/csv")}))
        await ok(await c.post(f"/ventures/{kit}/kitchen/events", json={
            "event_date": tomorrow.isoformat(), "name": "India vs Australia final", "multiplier": "1.25"}))
        await ok(await c.post(f"/ventures/{kit}/kitchen/run", json={"target_date": tomorrow.isoformat()}))
    print("demo data seeded")


if __name__ == "__main__":
    asyncio.run(main())
