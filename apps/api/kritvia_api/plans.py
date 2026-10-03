"""Plans and their limits. Prices are in rupees per month, before GST.

AI usage is counted in tokens sent to hosted models this calendar month (IST). Local models
(on your own server) are never counted. When a workspace runs out, Kritvia keeps working on
the local model where the tier has one, and stops only steps that need a hosted model.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class Plan:
    code: str
    name: str
    price_inr: int
    monthly_tokens: int | None      # None = unlimited
    max_ventures: int | None
    max_members: int | None
    autonomy: bool                  # agents may earn the right to act without asking

    def as_dict(self) -> dict:
        return asdict(self)


PLANS: dict[str, Plan] = {
    "free": Plan("free", "Free", 0, 300_000, 1, 2, False),
    "starter": Plan("starter", "Starter", 1999, 3_000_000, 3, 5, True),
    "pro": Plan("pro", "Pro", 5999, 15_000_000, 10, 20, True),
    "internal": Plan("internal", "Internal", 0, None, None, None, True),
}
PUBLIC_PLANS = ("free", "starter", "pro")


def plan(code: str | None) -> Plan:
    return PLANS.get(code or "free", PLANS["free"])
