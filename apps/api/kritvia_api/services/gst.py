"""GST arithmetic for tax invoices: GSTIN checks, states, line taxes, numbering and amounts in words.

Same state (supplier's GSTIN state = place of supply): CGST + SGST, each half the rate.
Another state: IGST at the full rate. Every line is rounded to the paisa (half up); totals are sums.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal

GST_RATES = (Decimal("0"), Decimal("0.1"), Decimal("0.25"), Decimal("1"), Decimal("1.5"), Decimal("3"), Decimal("5"),
             Decimal("6"), Decimal("12"), Decimal("18"), Decimal("28"), Decimal("40"))

STATES: dict[str, str] = {
    "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand",
    "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
    "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya",
    "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh",
    "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra", "29": "Karnataka",
    "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry",
    "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
    "97": "Other Territory",
}
_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def gstin_ok(gstin: str) -> bool:
    """Format, a known state, and the check character (GSTN's base-36 algorithm)."""
    g = (gstin or "").strip().upper()
    if len(g) != 15 or g[:2] not in STATES or any(c not in _CHARS for c in g):
        return False
    import re
    if not re.fullmatch(r"[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]", g):
        return False
    total = 0
    for i, c in enumerate(g[:14]):
        p = _CHARS.index(c) * (2 if i % 2 else 1)
        total += p // 36 + p % 36
    return g[14] == _CHARS[(36 - total % 36) % 36]


def financial_year(d: date) -> str:
    """1 Oct 2026 -> '26-27' (April to March)."""
    start = d.year if d.month >= 4 else d.year - 1
    return f"{start % 100:02d}-{(start + 1) % 100:02d}"


def invoice_number(prefix: str, fy: str, n: int) -> str:
    return f"{prefix}/{fy}/{n:04d}"


def _round(x: Decimal) -> int:
    return int(x.quantize(Decimal(1), rounding=ROUND_HALF_UP))


@dataclass
class Line:
    taxable: int
    cgst: int
    sgst: int
    igst: int


def line_tax(qty: Decimal, rate_paise: int, discount_paise: int, gst_rate: Decimal, same_state: bool) -> Line:
    gross = _round(qty * rate_paise)
    taxable = max(gross - discount_paise, 0)
    if same_state:
        half = _round(Decimal(taxable) * gst_rate / 200)
        return Line(taxable, half, half, 0)
    return Line(taxable, 0, 0, _round(Decimal(taxable) * gst_rate / 100))


_ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
         "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"]
_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]


def _two(n: int) -> str:
    return _ONES[n] if n < 20 else (_TENS[n // 10] + (" " + _ONES[n % 10] if n % 10 else ""))


def _three(n: int) -> str:
    h, r = divmod(n, 100)
    return " ".join(x for x in ((_ONES[h] + " Hundred") if h else "", _two(r) if r else "") if x)


def words(n: int) -> str:
    """Indian numbering: 1234567 -> 'Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven'."""
    if n == 0:
        return "Zero"
    parts = []
    crore, n = divmod(n, 10_000_000)
    lakh, n = divmod(n, 100_000)
    thousand, n = divmod(n, 1000)
    if crore:
        parts.append(words(crore) + " Crore")
    if lakh:
        parts.append(_two(lakh) + " Lakh")
    if thousand:
        parts.append(_two(thousand) + " Thousand")
    if n:
        parts.append(_three(n))
    return " ".join(parts)


def amount_in_words(paise: int) -> str:
    r, p = divmod(paise, 100)
    return f"Rupees {words(r)}" + (f" and {_two(p)} Paise" if p else "") + " Only"
