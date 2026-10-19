"""GSTR-1 for a month, from the tax invoices made in Kritvia.

Two files: an Excel workbook laid out like the GST offline tool's sheets (b2b, b2cl, b2cs, hsn, docs), which an
accountant can check and import, and the same data as GSTR-1 JSON. Only tax invoices (kind 'gst') count;
drafts don't, and cancelled ones are listed only in the document summary.

  b2b    invoices to a registered buyer (with a GSTIN), one row per invoice and tax rate
  b2cl   to an unregistered buyer in another state, invoice value above B2CL_LIMIT
  b2cs   the other sales to unregistered buyers, added up by place of supply and rate
  hsn    by HSN/SAC and rate
  docs   the invoice number range issued, and how many were cancelled

Kritvia doesn't file anything. Credit notes, exports, advances and amendments are not made in Kritvia, so
they aren't here: an accountant adds them before filing.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any

from kritvia_api.services.gst import STATES

B2CL_LIMIT = 100_000_00        # ₹1 lakh (from 1 Aug 2024), in paise


@dataclass
class Item:
    hsn: str | None
    description: str
    qty: Decimal
    unit: str | None
    rate: Decimal
    taxable: int
    cgst: int
    sgst: int
    igst: int


@dataclass
class Inv:
    number: str
    issued_on: date
    customer_name: str
    customer_gstin: str | None
    place_of_supply: str
    reverse_charge: bool
    amount_paise: int
    status: str
    items: list[Item] = field(default_factory=list)


def rupees(paise: int) -> float:
    return round(paise / 100, 2)


def pos_label(code: str) -> str:
    return f"{code}-{STATES.get(code, 'Other Territory')}"


def _by_rate(items: list[Item]) -> dict[Decimal, dict[str, int]]:
    out: dict[Decimal, dict[str, int]] = defaultdict(lambda: {"taxable": 0, "cgst": 0, "sgst": 0, "igst": 0})
    for it in items:
        r = out[it.rate]
        r["taxable"] += it.taxable
        r["cgst"] += it.cgst
        r["sgst"] += it.sgst
        r["igst"] += it.igst
    return dict(out)


def _num(rate: Decimal) -> float | int:
    f = float(rate)
    return int(f) if f.is_integer() else f


UQC = {"nos": "NOS-NUMBERS", "no": "NOS-NUMBERS", "pcs": "PCS-PIECES", "pc": "PCS-PIECES", "kg": "KGS-KILOGRAMS",
       "kgs": "KGS-KILOGRAMS", "g": "GMS-GRAMMES", "gm": "GMS-GRAMMES", "ltr": "LTR-LITRES", "l": "LTR-LITRES",
       "mtr": "MTR-METERS", "m": "MTR-METERS", "box": "BOX-BOX", "set": "SET-SETS", "hrs": "OTH-OTHERS",
       "month": "OTH-OTHERS"}


def uqc(unit: str | None, hsn: str | None) -> str:
    if hsn and hsn.startswith("99"):
        return "NA"                     # services
    return UQC.get((unit or "").strip().lower(), "OTH-OTHERS")


def build(gstin: str, state_code: str, year: int, month: int, invoices: list[Inv]) -> dict[str, Any]:
    """The month's GSTR-1 as sections of rows (for the workbook) and as GSTR-1 JSON."""
    live = [i for i in invoices if i.status in ("open", "paid")]
    b2b_rows: list[list[Any]] = []
    b2cl_rows: list[list[Any]] = []
    b2cs: dict[tuple[str, str, Decimal], dict[str, int]] = {}
    hsn: dict[tuple[str, Decimal], dict[str, Any]] = {}
    j_b2b: dict[str, list[dict[str, Any]]] = defaultdict(list)
    j_b2cl: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for inv in sorted(live, key=lambda x: (x.issued_on, x.number)):
        rates = _by_rate(inv.items)
        inter = inv.place_of_supply != state_code
        idt_x = inv.issued_on.strftime("%d-%b-%Y")
        idt_j = inv.issued_on.strftime("%d-%m-%Y")
        itms = [{"num": int(Decimal(r) * 100) + 1, "itm_det": {
            "txval": rupees(v["taxable"]), "rt": _num(r), "iamt": rupees(v["igst"]), "camt": rupees(v["cgst"]),
            "samt": rupees(v["sgst"]), "csamt": 0}} for r, v in sorted(rates.items())]
        if inv.customer_gstin:
            for r, v in sorted(rates.items()):
                b2b_rows.append([inv.customer_gstin, inv.customer_name, inv.number, idt_x, rupees(inv.amount_paise),
                                 pos_label(inv.place_of_supply), "Y" if inv.reverse_charge else "N", None, "Regular B2B",
                                 None, _num(r), rupees(v["taxable"]), 0])
            j_b2b[inv.customer_gstin].append({"inum": inv.number, "idt": idt_j, "val": rupees(inv.amount_paise),
                                              "pos": inv.place_of_supply, "rchrg": "Y" if inv.reverse_charge else "N",
                                              "inv_typ": "R", "itms": itms})
        elif inter and inv.amount_paise > B2CL_LIMIT:
            for r, v in sorted(rates.items()):
                b2cl_rows.append([inv.number, idt_x, rupees(inv.amount_paise), pos_label(inv.place_of_supply), None,
                                  _num(r), rupees(v["taxable"]), 0, None])
            j_b2cl[inv.place_of_supply].append({
                "inum": inv.number, "idt": idt_j, "val": rupees(inv.amount_paise),
                "itms": [{"num": x["num"], "itm_det": {k: x["itm_det"][k] for k in ("txval", "rt", "iamt", "csamt")}}
                         for x in itms]})
        else:
            for r, v in rates.items():
                k = ("INTER" if inter else "INTRA", inv.place_of_supply, r)
                s = b2cs.setdefault(k, {"taxable": 0, "cgst": 0, "sgst": 0, "igst": 0})
                for f in s:
                    s[f] += v[f]
        for it in inv.items:
            key = (it.hsn or "", it.rate)
            h = hsn.setdefault(key, {"desc": it.description[:30], "uqc": uqc(it.unit, it.hsn), "qty": Decimal(0),
                                     "val": 0, "taxable": 0, "igst": 0, "cgst": 0, "sgst": 0, "b2b": False})
            h["qty"] += it.qty
            h["val"] += it.taxable + it.cgst + it.sgst + it.igst
            h["taxable"] += it.taxable
            h["igst"] += it.igst
            h["cgst"] += it.cgst
            h["sgst"] += it.sgst
            h["b2b"] = h["b2b"] or bool(inv.customer_gstin)

    b2cs_rows = [["OE", pos_label(pos), None, _num(r), rupees(v["taxable"]), 0, None]
                 for (ty, pos, r), v in sorted(b2cs.items())]
    hsn_rows = [[k[0] or "", v["desc"], v["uqc"], float(v["qty"]), rupees(v["val"]), rupees(v["taxable"]),
                 rupees(v["igst"]), rupees(v["cgst"]), rupees(v["sgst"]), 0, _num(k[1])]
                for k, v in sorted(hsn.items(), key=lambda kv: (kv[0][0], kv[0][1]))]
    numbered = sorted(i.number for i in invoices if i.number)
    cancelled = sum(1 for i in invoices if i.status == "cancelled")
    docs_rows = ([["Invoices for outward supply", numbered[0], numbered[-1], len(numbered), cancelled]]
                 if numbered else [])
    j: dict[str, Any] = {"gstin": gstin, "fp": f"{month:02d}{year}"}
    if j_b2b:
        j["b2b"] = [{"ctin": c, "inv": v} for c, v in sorted(j_b2b.items())]
    if j_b2cl:
        j["b2cl"] = [{"pos": p, "inv": v} for p, v in sorted(j_b2cl.items())]
    if b2cs:
        j["b2cs"] = [{"sply_ty": ty, "pos": pos, "typ": "OE", "txval": rupees(v["taxable"]), "rt": _num(r),
                      "iamt": rupees(v["igst"]), "camt": rupees(v["cgst"]), "samt": rupees(v["sgst"]), "csamt": 0}
                     for (ty, pos, r), v in sorted(b2cs.items())]
    if hsn:
        j["hsn"] = {"data": [{"num": n, "hsn_sc": k[0], "desc": v["desc"], "uqc": v["uqc"].split("-")[0],
                              "qty": float(v["qty"]), "val": rupees(v["val"]), "txval": rupees(v["taxable"]),
                              "iamt": rupees(v["igst"]), "camt": rupees(v["cgst"]), "samt": rupees(v["sgst"]),
                              "csamt": 0, "rt": _num(k[1])}
                             for n, (k, v) in enumerate(sorted(hsn.items(), key=lambda kv: (kv[0][0], kv[0][1])), 1)]}
    if numbered:
        j["doc_issue"] = {"doc_det": [{"doc_num": 1, "docs": [{"num": 1, "from": numbered[0], "to": numbered[-1],
                                                               "totnum": len(numbered), "cancel": cancelled,
                                                               "net_issue": len(numbered) - cancelled}]}]}
    totals = {
        "invoices": len(live), "cancelled": cancelled,
        "taxable_paise": sum(it.taxable for i in live for it in i.items),
        "tax_paise": sum(it.cgst + it.sgst + it.igst for i in live for it in i.items),
        "b2b": sum(len(v) for v in j_b2b.values()), "b2cl": sum(len(v) for v in j_b2cl.values()),
        "b2cs_rows": len(b2cs_rows), "hsn_rows": len(hsn_rows),
        "missing_hsn": sum(1 for i in live for it in i.items if not it.hsn),
    }
    sheets = [
        ("b2b", [["GSTIN/UIN of Recipient", "Receiver Name", "Invoice Number", "Invoice date", "Invoice Value",
                  "Place Of Supply", "Reverse Charge", "Applicable % of Tax Rate", "Invoice Type", "E-Commerce GSTIN",
                  "Rate", "Taxable Value", "Cess Amount"], *b2b_rows]),
        ("b2cl", [["Invoice Number", "Invoice date", "Invoice Value", "Place Of Supply", "Applicable % of Tax Rate",
                   "Rate", "Taxable Value", "Cess Amount", "E-Commerce GSTIN"], *b2cl_rows]),
        ("b2cs", [["Type", "Place Of Supply", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount",
                   "E-Commerce GSTIN"], *b2cs_rows]),
        ("hsn", [["HSN", "Description", "UQC", "Total Quantity", "Total Value", "Taxable Value",
                  "Integrated Tax Amount", "Central Tax Amount", "State/UT Tax Amount", "Cess Amount", "Rate"],
                 *hsn_rows]),
        ("docs", [["Nature of Document", "Sr. No. From", "Sr. No. To", "Total Number", "Cancelled"], *docs_rows]),
    ]
    return {"json": j, "sheets": sheets, "totals": totals}
