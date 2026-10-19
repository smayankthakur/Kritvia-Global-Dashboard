"""Occasions a small Indian business markets around, with their dates for 2026 and 2027.

Dates are from calendarific.com's India holiday lists for 2026 and 2027 (read 19 Oct 2026); Eid dates there are
marked provisional (they follow the moon). Lohri (13 Jan) and Baisakhi (14 Apr) are fixed; Dhanteras is two days
before Diwali. Add 2028 before December 2027 (tests/test_grow_and_plan.py checks the list runs that far ahead).
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date


@dataclass(frozen=True)
class Occasion:
    key: str          # 'diwali-2026': one campaign per business per occasion
    name: str
    day: date
    note: str = ""    # what people do then, for the writer


_NOTES = {
    "new-year": "New Year wishes and plans",
    "lohri": "Punjabi winter harvest festival, bonfires",
    "makar-sankranti": "harvest festival, kites, til-gud (Pongal in the south)",
    "republic-day": "national holiday",
    "vasant-panchami": "spring, Saraswati puja, yellow",
    "valentines-day": "couples, gifts, dining out",
    "maha-shivaratri": "night of Shiva, fasting",
    "holi": "festival of colours, sweets, get-togethers",
    "eid-ul-fitr": "end of Ramzan, family feasts, new clothes",
    "gudi-padwa-ugadi": "new year in Maharashtra, Karnataka, Andhra and Telangana",
    "ram-navami": "Lord Rama's birthday",
    "baisakhi": "harvest festival and new year in Punjab",
    "mothers-day": "gifts and thanks for mothers",
    "eid-ul-adha": "Bakrid, family feasts",
    "fathers-day": "gifts and thanks for fathers",
    "independence-day": "national holiday, sales season",
    "raksha-bandhan": "brothers and sisters, rakhis, gifts, sweets",
    "onam": "Kerala's harvest festival, sadya",
    "janmashtami": "Lord Krishna's birthday",
    "ganesh-chaturthi": "Ganpati festival, modaks, ten days",
    "navratri": "nine nights, garba, fasting food",
    "dussehra": "victory of good over evil, start of the festive season",
    "karwa-chauth": "married women fast for their husbands",
    "dhanteras": "buying gold, utensils and new things",
    "diwali": "biggest festival: gifts, sweets, new clothes, cleaning, lighting",
    "bhai-dooj": "brothers and sisters",
    "chhath-puja": "sun worship in Bihar and eastern UP",
    "guru-nanak-jayanti": "Gurpurab, the first Sikh guru's birthday",
    "christmas": "Christmas and year-end parties",
}

_DATES: dict[int, dict[str, tuple[str, date]]] = {
    2026: {
        "new-year": ("New Year", date(2026, 1, 1)),
        "lohri": ("Lohri", date(2026, 1, 13)),
        "makar-sankranti": ("Makar Sankranti / Pongal", date(2026, 1, 14)),
        "republic-day": ("Republic Day", date(2026, 1, 26)),
        "vasant-panchami": ("Vasant Panchami", date(2026, 1, 23)),
        "valentines-day": ("Valentine's Day", date(2026, 2, 14)),
        "maha-shivaratri": ("Maha Shivaratri", date(2026, 2, 15)),
        "holi": ("Holi", date(2026, 3, 4)),
        "eid-ul-fitr": ("Eid ul-Fitr", date(2026, 3, 21)),
        "gudi-padwa-ugadi": ("Gudi Padwa / Ugadi", date(2026, 3, 19)),
        "ram-navami": ("Ram Navami", date(2026, 3, 26)),
        "baisakhi": ("Baisakhi", date(2026, 4, 14)),
        "mothers-day": ("Mother's Day", date(2026, 5, 10)),
        "eid-ul-adha": ("Eid ul-Adha (Bakrid)", date(2026, 5, 27)),
        "fathers-day": ("Father's Day", date(2026, 6, 21)),
        "independence-day": ("Independence Day", date(2026, 8, 15)),
        "onam": ("Onam", date(2026, 8, 26)),
        "raksha-bandhan": ("Raksha Bandhan", date(2026, 8, 28)),
        "janmashtami": ("Janmashtami", date(2026, 9, 4)),
        "ganesh-chaturthi": ("Ganesh Chaturthi", date(2026, 9, 14)),
        "navratri": ("Navratri", date(2026, 10, 11)),
        "dussehra": ("Dussehra", date(2026, 10, 20)),
        "dhanteras": ("Dhanteras", date(2026, 11, 6)),
        "diwali": ("Diwali", date(2026, 11, 8)),
        "bhai-dooj": ("Bhai Dooj", date(2026, 11, 11)),
        "chhath-puja": ("Chhath Puja", date(2026, 11, 15)),
        "guru-nanak-jayanti": ("Guru Nanak Jayanti", date(2026, 11, 24)),
        "christmas": ("Christmas", date(2026, 12, 25)),
    },
    2027: {
        "new-year": ("New Year", date(2027, 1, 1)),
        "lohri": ("Lohri", date(2027, 1, 13)),
        "makar-sankranti": ("Makar Sankranti / Pongal", date(2027, 1, 15)),
        "republic-day": ("Republic Day", date(2027, 1, 26)),
        "vasant-panchami": ("Vasant Panchami", date(2027, 2, 11)),
        "valentines-day": ("Valentine's Day", date(2027, 2, 14)),
        "maha-shivaratri": ("Maha Shivaratri", date(2027, 3, 6)),
        "eid-ul-fitr": ("Eid ul-Fitr", date(2027, 3, 10)),
        "holi": ("Holi", date(2027, 3, 22)),
        "gudi-padwa-ugadi": ("Gudi Padwa / Ugadi", date(2027, 4, 7)),
        "baisakhi": ("Baisakhi", date(2027, 4, 14)),
        "ram-navami": ("Ram Navami", date(2027, 4, 15)),
        "mothers-day": ("Mother's Day", date(2027, 5, 9)),
        "eid-ul-adha": ("Eid ul-Adha (Bakrid)", date(2027, 5, 17)),
        "fathers-day": ("Father's Day", date(2027, 6, 20)),
        "independence-day": ("Independence Day", date(2027, 8, 15)),
        "raksha-bandhan": ("Raksha Bandhan", date(2027, 8, 17)),
        "janmashtami": ("Janmashtami", date(2027, 8, 25)),
        "ganesh-chaturthi": ("Ganesh Chaturthi", date(2027, 9, 4)),
        "onam": ("Onam", date(2027, 9, 12)),
        "navratri": ("Navratri", date(2027, 9, 30)),
        "dussehra": ("Dussehra", date(2027, 10, 9)),
        "karwa-chauth": ("Karwa Chauth", date(2027, 10, 18)),
        "dhanteras": ("Dhanteras", date(2027, 10, 27)),
        "diwali": ("Diwali", date(2027, 10, 29)),
        "bhai-dooj": ("Bhai Dooj", date(2027, 10, 31)),
        "chhath-puja": ("Chhath Puja", date(2027, 11, 4)),
        "guru-nanak-jayanti": ("Guru Nanak Jayanti", date(2027, 11, 14)),
        "christmas": ("Christmas", date(2027, 12, 25)),
    },
}

ALL: list[Occasion] = sorted(
    (Occasion(f"{k}-{y}", name, d, _NOTES.get(k, "")) for y, days in _DATES.items() for k, (name, d) in days.items()),
    key=lambda o: o.day)
# Ones most businesses market around; the rest only when the owner names them.
MAJOR = {"new-year", "holi", "eid-ul-fitr", "raksha-bandhan", "independence-day", "ganesh-chaturthi", "navratri",
         "dussehra", "diwali", "christmas", "valentines-day", "mothers-day", "onam",
         "makar-sankranti"}


def base(key: str) -> str:
    return key.rsplit("-", 1)[0]


def upcoming(today: date, *, nearest: int = 7, furthest: int = 21, include: set[str] | None = None,
             skip: set[str] | None = None) -> list[Occasion]:
    """Occasions between `nearest` and `furthest` days away (enough time to plan, not so early it's forgotten).
    `include` adds minor ones by name ('lohri'); `skip` leaves any out."""
    want = MAJOR | (include or set())
    return [o for o in ALL if nearest <= (o.day - today).days <= furthest and base(o.key) in want
            and base(o.key) not in (skip or set())]


def last_day() -> date:
    return ALL[-1].day


def names() -> dict[str, str]:
    """Every occasion's base key and name, for the settings help."""
    out: dict[str, str] = {}
    for o in ALL:
        out.setdefault(base(o.key), o.name)
    return out
