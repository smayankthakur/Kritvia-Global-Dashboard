"""PII detection and masking for Indian business documents.

Aadhaar and card numbers are MASKED on ingestion (only the last four digits are
kept) — the business process rarely needs more, and DPDP data minimisation says
store only what it needs. PAN is kept because lending checks match on it, but
it is tagged so the document is treated as sensitive. Raw originals are
encrypted with the venture DEK and access-logged elsewhere.
"""
from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field

# Verhoeff tables (Aadhaar check digit)
_D = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
      [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
      [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
      [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]]
_P = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
      [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
      [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]]


def verhoeff_ok(num: str) -> bool:
    c = 0
    for i, ch in enumerate(reversed(num)):
        c = _D[c][_P[i % 8][int(ch)]]
    return c == 0


def luhn_ok(num: str) -> bool:
    total, alt = 0, False
    for ch in reversed(num):
        d = int(ch)
        if alt:
            d = d * 2 - 9 if d > 4 else d * 2
        total += d
        alt = not alt
    return total % 10 == 0


AADHAAR = re.compile(r"(?<!\d)([2-9]\d{3})[ -]?(\d{4})[ -]?(\d{4})(?!\d)")
CARD = re.compile(r"(?<!\d)(\d{4})[ -]?(\d{4})[ -]?(\d{4})[ -]?(\d{1,7})(?!\d)")
PAN = re.compile(r"\b([A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z])\b")
PHONE = re.compile(r"(?<![\d+])(?:\+?91[ -]?)?([6-9]\d{4})[ -]?(\d{5})(?!\d)")
EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
IFSC = re.compile(r"\b[A-Z]{4}0[A-Z0-9]{6}\b")
ACCOUNT = re.compile(r"(?i)\b(?:a/?c|account)(?:\s*(?:no\.?|number|#))?\s*[:\-]?\s*(\d{9,18})\b")
PASSPORT = re.compile(r"\b[A-PR-WY][1-9]\d\s?\d{4}[1-9]\b")


@dataclass
class PIIResult:
    text: str
    counts: dict[str, int] = field(default_factory=dict)

    @property
    def sensitive(self) -> bool:
        return any(k in self.counts for k in ("aadhaar", "pan", "card", "bank_account", "passport"))

    @property
    def tags(self) -> list[str]:
        return sorted(self.counts)


def mask(text: str) -> PIIResult:
    counts: Counter[str] = Counter()

    def aadhaar(m: re.Match) -> str:
        digits = "".join(m.groups())
        if not verhoeff_ok(digits):
            return m.group(0)
        counts["aadhaar"] += 1
        return f"XXXX-XXXX-{digits[-4:]}"

    def card(m: re.Match) -> str:
        digits = "".join(m.groups())
        if not (13 <= len(digits) <= 19 and luhn_ok(digits)):
            return m.group(0)
        counts["card"] += 1
        return f"XXXX-XXXX-XXXX-{digits[-4:]}"

    def account(m: re.Match) -> str:
        counts["bank_account"] += 1
        num = m.group(1)
        return m.group(0).replace(num, "X" * (len(num) - 4) + num[-4:])

    text = CARD.sub(card, text)
    text = AADHAAR.sub(aadhaar, text)
    text = ACCOUNT.sub(account, text)
    for name, rx in (("pan", PAN), ("passport", PASSPORT), ("ifsc", IFSC), ("email", EMAIL), ("phone", PHONE)):
        n = len(rx.findall(text))
        if n:
            counts[name] += n
    return PIIResult(text, dict(counts))


def find_pan(text: str) -> list[str]:
    return sorted(set(PAN.findall(text)))
