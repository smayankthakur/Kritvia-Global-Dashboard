"""Ads: what the business spends on Meta (Facebook/Instagram) and Google ads, and the leads they bring.

Kritvia never spends and never changes an ad account. A person exports the campaign report (Meta Ads Manager:
Export -> CSV/Excel; Google Ads: Campaigns -> Download -> CSV/Excel) and uploads it. Website-form leads carry
the ad that brought them (UTM tags, gclid, fbclid; workflows/lead_triage.ad_tags), so spend is set against
leads and won customers per campaign. The numbers are code; a model only words the advice, from those numbers.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date

from kritvia_api.services import bank


class ReportError(Exception):
    pass


@dataclass
class Row:
    campaign: str
    day_from: date
    day_to: date
    spend_paise: int
    impressions: int | None
    clicks: int | None
    results: int | None


ROLES = {
    "campaign": ("campaign name", "campaign"),
    "day": ("day", "date", "reporting date"),
    "start": ("reporting starts", "starts", "start date"),
    "end": ("reporting ends", "ends", "end date"),
    "spend": ("amount spent (inr)", "amount spent", "cost", "spend", "cost (inr)", "amount spent (₹)"),
    "impressions": ("impressions", "impr.", "impr"),
    "clicks": ("link clicks", "clicks", "clicks (all)"),
    "results": ("results", "conversions", "leads", "conv."),
}


def _role(h: str) -> str | None:
    h = re.sub(r"\s+", " ", (h or "").strip().lower())
    for role, names in ROLES.items():
        if h in names:
            return role
    return None


def _num(s: str | None) -> int | None:
    t = re.sub(r"[,\s₹]|INR", "", s or "")
    if not t or t in ("-", "--"):
        return None
    try:
        return int(float(t))
    except ValueError:
        return None


_RANGE = re.compile(r"(\d{1,2} [A-Za-z]{3,9},? \d{4}|[A-Za-z]{3,9} \d{1,2}, \d{4}|\d{4}-\d{2}-\d{2})\s*[-–to]+\s*"
                    r"(\d{1,2} [A-Za-z]{3,9},? \d{4}|[A-Za-z]{3,9} \d{1,2}, \d{4}|\d{4}-\d{2}-\d{2})")


def _d(s: str) -> date | None:
    from datetime import datetime
    got = bank.parse_date(s) or bank.parse_date(s.replace(",", ""))
    if got:
        return got
    for fmt in ("%B %d, %Y", "%B %d %Y"):
        try:
            return datetime.strptime(s.strip(), fmt).date()
        except ValueError:
            continue
    return None


def read(data: bytes, filename: str, period: tuple[date, date] | None = None) -> tuple[str, list[Row]]:
    """Returns (platform, rows). `period` is used when the report has neither a day column nor its own dates."""
    name = (filename or "").lower()
    rows = bank._xlsx_rows(data) if name.endswith(".xlsx") or data[:2] == b"PK" else bank._csv_rows(data)
    header_at, cols = None, {}
    found_period = None
    for i, row in enumerate(rows[:30]):
        m = _RANGE.search(" ".join(row))
        if m and found_period is None:
            a, b = _d(m.group(1)), _d(m.group(2))
            if a and b:
                found_period = (a, b)
        got = {}
        for j, h in enumerate(row):
            r = _role(h)
            if r and r not in got:
                got[r] = j
        if "campaign" in got and "spend" in got:
            header_at, cols = i, got
            break
    if header_at is None:
        raise ReportError("no campaign and spend columns found: upload the campaign report as exported")
    heads = " ".join(x.lower() for x in rows[header_at])
    platform = "meta" if "amount spent" in heads or "reporting starts" in heads else (
        "google" if "cost" in heads or "impr" in heads else "other")
    out: list[Row] = []
    for row in rows[header_at + 1:]:
        def cell(role: str) -> str:
            j = cols.get(role)
            return row[j].strip() if j is not None and j < len(row) else ""
        camp = cell("campaign")
        if not camp or camp.lower().startswith(("total", "--")) or camp in ("-",):
            continue
        spend = bank.paise(cell("spend"))
        if spend is None:
            continue
        if cell("day"):
            d1 = d2 = _d(cell("day"))
        elif cell("start") and cell("end"):
            d1, d2 = _d(cell("start")), _d(cell("end"))
        else:
            d1, d2 = (found_period or period or (None, None))
        if not d1 or not d2:
            raise ReportError("this report has no dates: choose the period it covers and upload it again")
        out.append(Row(campaign=camp[:200], day_from=min(d1, d2), day_to=max(d1, d2), spend_paise=max(0, spend),
                       impressions=_num(cell("impressions")), clicks=_num(cell("clicks")),
                       results=_num(cell("results"))))
        if len(out) > 5000:
            break
    if not out:
        raise ReportError("no campaign rows with spend found in this report")
    return platform, out


def per_lead(spend: int, n: int) -> int | None:
    return spend // n if n else None
