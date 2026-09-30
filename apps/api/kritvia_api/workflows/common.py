"""Deterministic helpers shared by workflows. No LLM in here."""
from __future__ import annotations

import re
from datetime import date, datetime, time, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from difflib import SequenceMatcher

IST = timezone(timedelta(hours=5, minutes=30))
PAISE = Decimal("0.01")

_MULT = {"k": 1_000, "thousand": 1_000, "l": 100_000, "lac": 100_000, "lakh": 100_000, "lakhs": 100_000,
         "lacs": 100_000, "cr": 10_000_000, "crore": 10_000_000, "crores": 10_000_000,
         "m": 1_000_000, "mn": 1_000_000, "million": 1_000_000}
_AMOUNT = re.compile(
    r"(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|lakhs?|lacs?|l|crores?|cr|million|mn|m)?\b",
    re.I)


def parse_inr(text: str | None) -> Decimal | None:
    """'₹3.5 lakh' -> 350000, '2,50,000' -> 250000, '5k' -> 5000, '1.2 cr' -> 12000000.
    Ranges ('3-5 lakh') return the upper bound. USD amounts are not converted (None)."""
    if not text:
        return None
    t = text.lower().replace("–", "-")
    if "$" in t or "usd" in t or "dollar" in t:
        return None
    m_range = re.search(r"(\d[\d,.]*)\s*(?:-|to)\s*(\d[\d,.]*)\s*([a-z]+)?", t)
    if m_range:
        t = f"{m_range.group(2)} {m_range.group(3) or ''}"
    best = None
    for m in _AMOUNT.finditer(t):
        num = Decimal(m.group(1).replace(",", ""))
        mult = _MULT.get((m.group(2) or "").lower(), 1)
        val = num * mult
        if val >= 1000 and (best is None or val > best):
            best = val
    return best.quantize(PAISE) if best is not None else None


def money(x: Decimal | float | int | str) -> Decimal:
    return Decimal(str(x)).quantize(PAISE, ROUND_HALF_UP)


def fmt_inr(x: Decimal | float | int | str) -> str:
    """Indian digit grouping: 1234567.5 -> ₹12,34,567.50"""
    d = money(x)
    sign = "-" if d < 0 else ""
    whole, frac = f"{abs(d):.2f}".split(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        whole = ",".join(groups + [tail])
    return f"{sign}₹{whole}.{frac}"


def name_similarity(a: str | None, b: str | None) -> float:
    """Token-sort similarity, tolerant of initials ('S. Sharma' ~ 'Suresh Sharma')."""
    if not a or not b:
        return 0.0
    def toks(s: str) -> list[str]:
        return sorted(t for t in re.sub(r"[^a-z\s]", " ", s.lower()).split() if t not in ("mr", "mrs", "ms", "shri",
                                                                                               "smt", "dr"))
    ta, tb = toks(a), toks(b)
    if not ta or not tb:
        return 0.0
    base = SequenceMatcher(None, " ".join(ta), " ".join(tb)).ratio()
    # initials: every token of the shorter name matches a token or initial of the longer
    short, long_ = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
    if all(any(t == u or (len(t) == 1 and u.startswith(t)) or (len(u) == 1 and t.startswith(u)) for u in long_)
           for t in short):
        base = max(base, 0.9 if len(short) >= 2 else 0.75)
    return round(base, 3)


def parse_date(text: str | None) -> date | None:
    if not text:
        return None
    t = text.strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y", "%d %b %Y", "%d %B %Y", "%b %Y", "%B %Y",
                "%m/%Y", "%Y-%m"):
        try:
            return datetime.strptime(t, fmt).date()
        except ValueError:
            continue
    return None


def today_ist() -> date:
    return datetime.now(IST).date()


def next_business_slot(after: datetime | None = None, hour: int = 11, minutes: int = 30) -> tuple[str, str]:
    """Next weekday (Mon–Sat, Indian business week) at `hour` IST, at least 20h ahead."""
    now = (after or datetime.now(IST)).astimezone(IST)
    d = (now + timedelta(hours=20)).date()
    start = datetime.combine(d, time(hour, 0), IST)
    if start < now + timedelta(hours=20):
        d = d + timedelta(days=1)
    while d.weekday() == 6:  # Sunday
        d = d + timedelta(days=1)
    start = datetime.combine(d, time(hour, 0), IST)
    end = start + timedelta(minutes=minutes)
    return start.isoformat(), end.isoformat()


CURRENCY_IN_TEXT = re.compile(r"(?:₹|rs\.?\s|inr\s)\s*[\d,]+(?:\.\d+)?(?:\s*(?:lakh|lakhs|cr|crore|k))?", re.I)
