"""Trade: shipment files for exporters, importers and C&F (clearing and forwarding) agents.

One `shipments` row is one consignment. Its flow decides the stages and the document checklist:

  export      our own export:  order → production → booking → documents → customs (shipping bill)
                               → shipped → arrived → paid (proceeds realised) → closed
  import      our own import:  order → shipped → arrived → customs (bill of entry) → duty_paid
                               → cleared (out of charge) → delivered → paid (supplier paid) → closed
  job_export  a C&F agent clearing a client's export: documents → customs → cleared (let export order)
                               → shipped → closed
  job_import  a C&F agent clearing a client's import: arrived → documents → customs → duty_paid
                               → cleared (out of charge) → delivered → closed

`alerts()` turns a file's dates and checklist into what needs a person's attention: cut-offs with
documents missing, sailings and arrivals, LC expiry, export proceeds to realise, cargo waiting at port,
and C&F jobs not billed. Pure functions; the router and the trade_watch agent use them.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from kritvia_api.services.gst import financial_year

FLOWS: dict[str, tuple[str, ...]] = {
    "export": ("order", "production", "booking", "documents", "customs", "shipped", "arrived", "paid", "closed"),
    "import": ("order", "shipped", "arrived", "customs", "duty_paid", "cleared", "delivered", "paid", "closed"),
    "job_export": ("documents", "customs", "cleared", "shipped", "closed"),
    "job_import": ("arrived", "documents", "customs", "duty_paid", "cleared", "delivered", "closed"),
}
ALL_STAGES = ("order", "production", "booking", "documents", "customs", "cleared", "duty_paid", "shipped",
              "arrived", "delivered", "paid", "closed", "cancelled")
OPEN = frozenset(ALL_STAGES) - {"closed", "cancelled"}

STAGE_LABELS: dict[str, dict[str, str]] = {
    "export": {"order": "Order confirmed", "production": "In production", "booking": "Space booked",
               "documents": "Documents being prepared", "customs": "Shipping bill filed", "cleared": "Let export order",
               "shipped": "Shipped", "arrived": "Arrived at destination", "paid": "Payment realised",
               "closed": "Closed", "cancelled": "Cancelled"},
    "import": {"order": "Order placed", "shipped": "Shipped by supplier", "arrived": "Arrived at port",
               "documents": "Documents received", "customs": "Bill of entry filed", "duty_paid": "Duty paid",
               "cleared": "Out of charge", "delivered": "Delivered", "paid": "Supplier paid",
               "closed": "Closed", "cancelled": "Cancelled"},
}
INCOTERMS = ("EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP")
PAYMENT_TERMS = {"advance": "Advance", "lc": "Letter of credit", "dp": "Documents against payment (D/P)",
                 "da": "Documents against acceptance (D/A)", "cad": "Cash against documents", "open": "Open account",
                 "other": "Other"}

# (code, name, needed by stage) per flow; insurance only when the seller insures (CIF/CIP) or we import
# on terms where we buy it.
DOCS: dict[str, tuple[tuple[str, str, str], ...]] = {
    "export": (
        ("purchase_order", "Buyer's purchase order", "order"),
        ("proforma_invoice", "Proforma invoice", "order"),
        ("commercial_invoice", "Commercial invoice", "documents"),
        ("packing_list", "Packing list", "documents"),
        ("shipping_bill", "Shipping bill", "customs"),
        ("bill_of_lading", "Bill of lading / air waybill", "shipped"),
        ("certificate_of_origin", "Certificate of origin", "shipped"),
        ("insurance", "Insurance certificate", "shipped"),
        ("brc", "Bank realisation certificate (eBRC)", "paid"),
    ),
    "import": (
        ("purchase_order", "Purchase order", "order"),
        ("commercial_invoice", "Supplier's commercial invoice", "arrived"),
        ("packing_list", "Packing list", "arrived"),
        ("bill_of_lading", "Bill of lading / air waybill", "arrived"),
        ("insurance", "Insurance certificate", "arrived"),
        ("certificate_of_origin", "Certificate of origin (for FTA duty benefit)", "customs"),
        ("bill_of_entry", "Bill of entry", "customs"),
        ("duty_challan", "Duty payment challan", "duty_paid"),
        ("delivery_order", "Delivery order", "cleared"),
        ("payment_advice", "Payment advice / SWIFT copy", "paid"),
    ),
    "job_export": (
        ("kyc", "Client KYC (IEC, GSTIN, PAN, authorisation)", "documents"),
        ("commercial_invoice", "Commercial invoice", "documents"),
        ("packing_list", "Packing list", "documents"),
        ("shipping_bill", "Shipping bill", "customs"),
        ("bill_of_lading", "Bill of lading / air waybill", "shipped"),
    ),
    "job_import": (
        ("kyc", "Client KYC (IEC, GSTIN, PAN, authorisation)", "documents"),
        ("bill_of_lading", "Bill of lading / air waybill", "documents"),
        ("commercial_invoice", "Commercial invoice", "documents"),
        ("packing_list", "Packing list", "documents"),
        ("bill_of_entry", "Bill of entry", "customs"),
        ("duty_challan", "Duty payment challan", "duty_paid"),
        ("delivery_order", "Delivery order", "cleared"),
    ),
}
EXTRA_DOCS: tuple[tuple[str, str], ...] = (
    ("lc_copy", "Letter of credit"),
    ("phytosanitary", "Phytosanitary certificate"),
    ("fumigation", "Fumigation certificate"),
    ("health_certificate", "Health certificate"),
    ("fssai_noc", "FSSAI import clearance (NOC)"),
    ("apeda_rcmc", "APEDA / EPC registration (RCMC)"),
    ("inspection", "Pre-shipment inspection certificate"),
    ("test_report", "Test report / certificate of analysis"),
    ("bis", "BIS certificate"),
    ("weight_certificate", "Weight certificate"),
    ("eway_bill", "E-way bill"),
    ("lut_copy", "LUT acknowledgement"),
)

CURRENCY_DIGITS = {"JPY": 0, "KRW": 0, "VND": 0, "IDR": 0, "KWD": 3, "BHD": 3, "OMR": 3, "JOD": 3}
REALISE_WARN_DAYS = 30


def flow(direction: str, for_client: bool) -> str:
    return f"job_{direction}" if for_client else direction


def stages(direction: str, for_client: bool) -> tuple[str, ...]:
    return FLOWS[flow(direction, for_client)]


def stage_label(direction: str, stage: str) -> str:
    return STAGE_LABELS[direction].get(stage, stage.replace("_", " ").capitalize())


def stage_index(direction: str, for_client: bool, stage: str) -> int:
    s = stages(direction, for_client)
    return s.index(stage) if stage in s else -1


def reached(direction: str, for_client: bool, stage: str, target: str) -> bool:
    """True when the file is at `target` or past it (a stage not in this flow counts as not reached)."""
    s = stages(direction, for_client)
    if stage in ("closed",):
        return True
    if stage not in s or target not in s:
        return False
    return s.index(stage) >= s.index(target)


def doc_template(direction: str, for_client: bool, incoterm: str | None, payment_terms: str | None) -> list[tuple[str, str, str]]:
    out = []
    for code, name, needed in DOCS[flow(direction, for_client)]:
        if code == "insurance":
            if direction == "export" and (incoterm or "") not in ("CIF", "CIP"):
                continue
            if direction == "import" and (incoterm or "") in ("CIF", "CIP", "DAP", "DPU", "DDP"):
                continue
        out.append((code, name, needed))
    if payment_terms == "lc":
        out.insert(0, ("lc_copy", "Letter of credit", "order" if not for_client else "documents"))
    return out


def number(prefix: str, fy: str, n: int) -> str:
    return f"{prefix}/{fy}/{n:04d}"


def series_kind(direction: str, for_client: bool) -> str:
    return "job" if for_client else direction


def fy_now(today: date | None = None) -> str:
    return financial_year(today or datetime.now(UTC).date())


def digits(currency: str) -> int:
    return CURRENCY_DIGITS.get(currency, 2)


def to_minor(amount: Decimal | float | str, currency: str) -> int:
    q = Decimal(str(amount)) * (Decimal(10) ** digits(currency))
    return int(q.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def money(minor: int | None, currency: str) -> str:
    d = digits(currency)
    v = Decimal(int(minor or 0)) / (Decimal(10) ** d)
    return f"{currency} {v:,.{d}f}"


def line_amount(qty: Decimal, unit_price_minor: int) -> int:
    return int((Decimal(qty) * Decimal(unit_price_minor)).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def add_months(d: date, months: int) -> date:
    y, m = divmod(d.month - 1 + months, 12)
    y, m = d.year + y, m + 1
    import calendar
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


# ------------------------------------------------------------------------------- alerts --
@dataclass
class Alert:
    level: str          # "urgent" | "soon" | "info"
    kind: str
    text: str


def _days(a: date, b: date) -> int:
    return (a - b).days


def alerts(s: Any, docs: list[Any], today: date, now: datetime | None = None) -> list[Alert]:
    """What needs a person on this file today. `s` is a shipments row, `docs` its shipment_docs rows."""
    now = now or datetime.now(UTC)
    out: list[Alert] = []
    if s.stage not in OPEN:
        if s.stage == "closed" and s.for_client and s.fee_paise and s.invoice_id is None:
            out.append(Alert("soon", "unbilled", "Closed but not billed to the client yet"))
        return out
    st = s.stage
    d, fc = s.direction, s.for_client
    missing = [x for x in docs if x.status == "needed"]
    shipped = reached(d, fc, st, "shipped")
    arrived = reached(d, fc, st, "arrived")

    if s.cutoff_at is not None and not shipped:
        hours = (s.cutoff_at - now).total_seconds() / 3600
        pre = [x for x in missing if x.needed_by in (None, "order", "production", "booking", "documents", "customs", "cleared")]
        if hours < 0:
            out.append(Alert("urgent", "cutoff", "Cut-off has passed and it isn't marked shipped"
                             + (f"; {len(pre)} document(s) still needed" if pre else "")))
        elif hours <= 48:
            out.append(Alert("urgent" if pre else "soon", "cutoff",
                             f"Cut-off in {max(1, round(hours))} h" + (f"; {len(pre)} document(s) still needed" if pre else "")))
    if s.etd is not None and not shipped:
        n = _days(s.etd, today)
        if n < 0:
            out.append(Alert("urgent", "etd", f"Was due to sail {-n} day(s) ago; not marked shipped"))
        elif n <= 2:
            out.append(Alert("soon", "etd", "Sails today" if n == 0 else f"Sails in {n} day(s)"))
    if s.eta is not None and not arrived and (d == "import" or fc):
        n = _days(s.eta, today)
        if n < 0:
            out.append(Alert("soon", "eta", f"Was due {-n} day(s) ago; not marked arrived"))
        elif n <= 2:
            out.append(Alert("soon", "eta", "Arrives today" if n == 0 else f"Arrives in {n} day(s)"))
    if d == "import" and s.arrived_on is not None and not reached(d, fc, st, "cleared"):
        n = _days(today, s.arrived_on)
        if n >= 3:
            out.append(Alert("urgent" if n >= 5 else "soon", "port",
                             f"At port {n} days and not cleared: demurrage and detention charges add up"))
    if s.payment_terms == "lc" and not reached(d, fc, st, "paid"):
        if s.lc_last_shipment is not None and not shipped:
            n = _days(s.lc_last_shipment, today)
            if n <= 7:
                out.append(Alert("urgent", "lc", "LC latest shipment date has passed" if n < 0
                                 else f"LC latest shipment date in {n} day(s)"))
        if s.lc_expiry is not None:
            n = _days(s.lc_expiry, today)
            if n <= 15:
                out.append(Alert("urgent", "lc", "LC has expired" if n < 0 else f"LC expires in {n} day(s)"))
    if d == "export" and not fc and s.realise_by is not None and s.realised_on is None and s.received_minor < s.value_minor:
        n = _days(s.realise_by, today)
        if n < 0:
            out.append(Alert("urgent", "realise", f"Export proceeds were due to be realised {-n} day(s) ago"))
        elif n <= REALISE_WARN_DAYS:
            out.append(Alert("soon", "realise", f"Export proceeds to be realised within {n} day(s)"))
    late = [x for x in missing if x.needed_by and reached(d, fc, st, x.needed_by) and x.needed_by != st]
    if late:
        names = ", ".join(x.name for x in late[:3]) + ("…" if len(late) > 3 else "")
        out.append(Alert("soon", "docs", f"Still needed: {names}"))
    return out


def lut_alert(profile: Any, today: date) -> Alert | None:
    if profile is None or "exporter" not in (profile.roles or []):
        return None
    if not profile.lut_arn:
        return Alert("info", "lut", "No LUT on the trade profile: exports will need IGST paid, or file the LUT on the GST portal")
    if profile.lut_valid_until is not None:
        n = _days(profile.lut_valid_until, today)
        if n < 0:
            return Alert("urgent", "lut", "Your LUT has expired: file a new one on the GST portal before the next export")
        if n <= 30:
            return Alert("soon", "lut", f"Your LUT expires in {n} day(s)")
    return None


def status_message(s: Any, profile_name: str, stage_text: str, note: str = "") -> str:
    """A short status update to the buyer, supplier or client, written from the file (nothing guessed)."""
    first = (s.party_name or "").split(" ")[0] or "there"
    bits = [f"Hi {first}, an update on {('your ' if s.for_client else 'shipment ') + s.number}"
            + (f" (your ref. {s.reference})" if s.reference else "") + f": {stage_text.lower()}."]
    detail = []
    if s.vessel:
        detail.append(f"{'Flight' if s.mode == 'air' else 'Vessel'}: {s.vessel}")
    if s.bl_no:
        detail.append(f"{'AWB' if s.mode == 'air' else 'BL'} no. {s.bl_no}")
    if s.containers:
        detail.append(f"Container(s): {s.containers}")
    if s.etd and not s.shipped_on:
        detail.append(f"ETD {s.etd:%d %b %Y}")
    if s.shipped_on:
        detail.append(f"Shipped on {s.shipped_on:%d %b %Y}")
    if s.eta and not s.arrived_on:
        detail.append(f"ETA {s.eta:%d %b %Y}")
    if s.customs_no:
        detail.append(f"{'Shipping bill' if s.direction == 'export' else 'Bill of entry'} no. {s.customs_no}")
    if detail:
        bits.append("; ".join(detail) + ".")
    if note.strip():
        bits.append(note.strip()[:400])
    bits.append(f"— {profile_name}")
    return "\n".join(bits)
