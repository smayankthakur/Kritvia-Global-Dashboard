"""Tally Prime XML import.

Tally has no cloud API; what every Tally user *can* do is export. Day Book
(Display → Day Book → Export → XML) or a ledger's vouchers come out as
`<ENVELOPE>…<VOUCHER>` records. This module turns them into rows the business
can query ("what did we bill Acme last month?", "who owes us?") and into one
readable document per import so answers carry a citation.

Only what the business needs is kept: date, type, number, party, narration,
amount and the ledger split. Nothing is sent back to Tally.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from defusedxml import ElementTree as ET

MAX_BYTES = 40 * 1024 * 1024
_CTRL = re.compile(rb"[\x00-\x08\x0b\x0c\x0e-\x1f]")


class TallyParseError(Exception):
    pass


@dataclass
class Voucher:
    guid: str
    voucher_type: str
    number: str | None
    day: date
    party: str | None
    narration: str | None
    amount: Decimal
    ledgers: list[dict[str, Any]] = field(default_factory=list)

    @property
    def direction(self) -> str:
        t = self.voucher_type.lower()
        if t in ("sales", "credit note") or t.startswith("sales"):
            return "in"
        if t in ("purchase", "debit note") or t.startswith("purchase"):
            return "out"
        if t == "receipt":
            return "in"
        if t == "payment":
            return "out"
        return "other"


def _text(el, tag: str) -> str | None:
    found = el.find(tag)
    if found is None or found.text is None:
        return None
    t = found.text.strip()
    return t or None


def _amount(s: str | None) -> Decimal:
    if not s:
        return Decimal(0)
    s = s.replace(",", "").strip()
    # Tally writes "-11800.00" for credits; "(-)11800" never appears in exports but guard anyway
    s = s.replace("(-)", "-")
    try:
        return Decimal(s)
    except InvalidOperation:
        return Decimal(0)


def _date(s: str | None) -> date | None:
    if not s:
        return None
    for fmt in ("%Y%m%d", "%d-%b-%Y", "%d-%b-%y", "%Y-%m-%d"):
        try:
            return datetime.strptime(s.strip(), fmt).date()
        except ValueError:
            continue
    return None


def parse_vouchers(data: bytes) -> list[Voucher]:
    if len(data) > MAX_BYTES:
        raise TallyParseError("file is larger than 40 MB; export a shorter period")
    cleaned = _CTRL.sub(b"", data)
    # Tally exports declare encodings like "UTF-16" or "ISO-8859-1"; decode to text and let ET re-parse.
    try:
        text = cleaned.decode("utf-16") if cleaned[:2] in (b"\xff\xfe", b"\xfe\xff") else cleaned.decode("utf-8")
    except UnicodeDecodeError:
        text = cleaned.decode("latin-1")
    text = re.sub(r"<\?xml[^>]*\?>", "", text, count=1)
    try:
        root = ET.fromstring(text)
    except ET.ParseError as exc:
        raise TallyParseError(f"not a Tally XML export ({exc})") from None
    out: list[Voucher] = []
    for v in root.iter("VOUCHER"):
        day = _date(_text(v, "DATE"))
        vtype = _text(v, "VOUCHERTYPENAME") or v.get("VCHTYPE") or "Voucher"
        if day is None:
            continue
        guid = _text(v, "GUID") or v.get("REMOTEID") or ""
        party = _text(v, "PARTYLEDGERNAME") or _text(v, "PARTYNAME")
        ledgers: list[dict[str, Any]] = []
        for le in list(v.iter("ALLLEDGERENTRIES.LIST")) + list(v.iter("LEDGERENTRIES.LIST")):
            name = _text(le, "LEDGERNAME")
            if not name:
                continue
            amt = _amount(_text(le, "AMOUNT"))
            ledgers.append({"ledger": name, "amount": str(amt),
                            "side": "cr" if amt < 0 else "dr"})
        party_entry = next((l for l in ledgers if party and l["ledger"] == party), None)
        if party_entry:
            amount = abs(Decimal(party_entry["amount"]))
        elif ledgers:
            amount = max(abs(Decimal(l["amount"])) for l in ledgers)
        else:
            amount = abs(_amount(_text(v, "AMOUNT")))
        if not guid:
            guid = f"{day.isoformat()}:{vtype}:{_text(v, 'VOUCHERNUMBER') or ''}:{party or ''}:{amount}"
        out.append(Voucher(guid=guid[:200], voucher_type=vtype[:60], number=(_text(v, "VOUCHERNUMBER") or None),
                           day=day, party=party and party[:200], narration=(_text(v, "NARRATION") or None),
                           amount=amount.quantize(Decimal("0.01")), ledgers=ledgers[:50]))
    if not out:
        raise TallyParseError("no vouchers found — export the Day Book or a ledger as XML from Tally")
    return out


def summarise(vouchers: list[Voucher]) -> dict[str, Any]:
    by_type: dict[str, dict[str, Any]] = {}
    parties: dict[str, Decimal] = {}
    for v in vouchers:
        t = by_type.setdefault(v.voucher_type, {"count": 0, "total": Decimal(0)})
        t["count"] += 1
        t["total"] += v.amount
        if v.party and v.direction in ("in", "out"):
            sign = 1 if v.voucher_type.lower().startswith("sales") else (-1 if v.voucher_type.lower() == "receipt" else 0)
            if sign:
                parties[v.party] = parties.get(v.party, Decimal(0)) + sign * v.amount
    days = sorted(v.day for v in vouchers)
    return {"from": days[0].isoformat(), "to": days[-1].isoformat(), "count": len(vouchers),
            "by_type": {k: {"count": t["count"], "total": str(t["total"])} for k, t in sorted(by_type.items())},
            "outstanding": {k: str(a) for k, a in sorted(parties.items(), key=lambda kv: -kv[1]) if a > 0}}


def render_document(vouchers: list[Voucher], summary: dict[str, Any], *, business: str) -> str:
    """Plain-text document for the knowledge base: summary first, then one line per voucher."""
    lines = [f"Tally import for {business}: {summary['count']} vouchers from {summary['from']} to {summary['to']}.", ""]
    lines.append("Totals by voucher type:")
    for k, t in summary["by_type"].items():
        lines.append(f"- {k}: {t['count']} vouchers, ₹{t['total']}")
    if summary["outstanding"]:
        lines.append("")
        lines.append("Billed minus received per party in this period (positive = still owed to us):")
        for p, a in list(summary["outstanding"].items())[:100]:
            lines.append(f"- {p}: ₹{a}")
    lines.append("")
    lines.append("Vouchers:")
    for v in sorted(vouchers, key=lambda x: (x.day, x.number or "")):
        bits = [v.day.isoformat(), v.voucher_type]
        if v.number:
            bits.append(f"#{v.number}")
        if v.party:
            bits.append(v.party)
        bits.append(f"₹{v.amount}")
        if v.narration:
            bits.append(f"— {v.narration[:200]}")
        lines.append(" ".join(bits))
    return "\n".join(lines)
