"""Kritvia Tally sync: run this on the PC where Tally Prime is open, every hour (Windows Task Scheduler).

What it does, each time:
  1. asks Tally (its own XML server, http://localhost:9000) for the Day Book of the last few days and sends it to
     Kritvia, so Kritvia knows who was billed and who paid;
  2. takes Kritvia's new invoices into Tally as Sales vouchers (the customer's ledger is made under Sundry Debtors
     if it isn't there), and tells Kritvia which ones Tally created, so each goes in once.

Setup (once):
  - In Tally: F1 Help > Settings > Connectivity > "TallyPrime acts as" Both, port 9000 (Tally's default).
  - In Kritvia: Money > Tally > Make a sync key. Put the address and key in kritvia_tally_sync.ini next to this
    file (see kritvia_tally_sync.example.ini). Keep the key private: anyone with it can send Kritvia Tally data.
  - Needs Python 3.9 or newer; no other packages.
  - Try it: python kritvia_tally_sync.py   then add it to Task Scheduler (every hour while Tally is open).

Nothing else on the PC is read; only Tally's own export and Kritvia's answers cross the network.
"""
from __future__ import annotations

import configparser
import json
import re
import sys
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
TIMEOUT = 60


def load() -> dict[str, str]:
    cfg = configparser.ConfigParser()
    if not cfg.read(HERE / "kritvia_tally_sync.ini"):
        sys.exit("kritvia_tally_sync.ini is missing: copy kritvia_tally_sync.example.ini and fill it in")
    k = cfg["kritvia"]
    t = cfg["tally"] if cfg.has_section("tally") else {}
    out = {"hook": k.get("hook_url", "").rstrip("/"), "key": k.get("sync_key", "").strip(),
           "tally": (t.get("url") if t else None) or "http://localhost:9000",
           "days": (t.get("days") if t else None) or "7", "company": (t.get("company") if t else None) or ""}
    if not out["hook"].startswith("https://") or "/hooks/tally/" not in out["hook"]:
        sys.exit("hook_url must be the https address Kritvia showed with the sync key")
    if not out["key"].startswith("kts_"):
        sys.exit("sync_key must be the key Kritvia showed (it starts with kts_)")
    return out


def post(url: str, data: bytes, headers: dict[str, str]) -> bytes:
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:  # noqa: S310 - fixed http(s) addresses from the ini
        return r.read()


def kritvia(c: dict[str, str], path: str, body: bytes | None = None, ctype: str = "application/xml") -> bytes:
    headers = {"X-Kritvia-Key": c["key"], "User-Agent": "kritvia-tally-sync/1"}
    url = c["hook"] + path
    if body is None:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:  # noqa: S310
            return r.read()
    return post(url, body, {**headers, "Content-Type": ctype})


def tally(c: dict[str, str], xml: str) -> str:
    return post(c["tally"], xml.encode("utf-8"), {"Content-Type": "text/xml; charset=utf-8"}).decode("utf-8", "replace")


def daybook_request(c: dict[str, str]) -> str:
    to = date.today()
    frm = to - timedelta(days=int(c["days"]))
    company = f"<SVCURRENTCOMPANY>{c['company']}</SVCURRENTCOMPANY>" if c["company"] else ""
    return ("<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE>"
            "<ID>Day Book</ID></HEADER><BODY><DESC><STATICVARIABLES>"
            "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>"
            f"<SVFROMDATE>{frm:%Y%m%d}</SVFROMDATE><SVTODATE>{to:%Y%m%d}</SVTODATE>{company}"
            "</STATICVARIABLES></DESC></BODY></ENVELOPE>")


def created(answer: str) -> bool:
    """Tally answers an import with <CREATED>n</CREATED> (or ALTERED) and <ERRORS>n</ERRORS> per request."""
    num = lambda tag: int((re.search(rf"<{tag}>(\d+)</{tag}>", answer) or [0, "0"])[1])  # noqa: E731
    return num("ERRORS") == 0 and (num("CREATED") + num("ALTERED") + num("COMBINED")) >= 1


def main() -> int:
    c = load()
    try:
        book = tally(c, daybook_request(c))
    except (urllib.error.URLError, OSError) as exc:
        print(f"Tally isn't answering at {c['tally']} ({exc}). Is Tally open, with Connectivity on port 9000?")
        return 1
    try:
        got = json.loads(kritvia(c, "/import", book.encode("utf-8")))
        print(f"Day Book sent to Kritvia: {got.get('imported', 0)} new voucher(s), {got.get('updated', 0)} updated")
    except urllib.error.HTTPError as exc:
        print(f"Kritvia didn't take the Day Book: HTTP {exc.code} {exc.read()[:200]!r}")
        if exc.code == 401:
            return 1
    try:
        sales = json.loads(kritvia(c, "/sales"))["vouchers"]
    except urllib.error.HTTPError as exc:
        print(f"Kritvia's invoices couldn't be fetched: HTTP {exc.code}")
        return 1
    done, failed = [], []
    for v in sales:
        answer = tally(c, v["xml"])
        (done if created(answer) else failed).append(v)
        if not created(answer):
            line = re.search(r"<LINEERROR>(.*?)</LINEERROR>", answer, re.S)
            print(f"Tally didn't take invoice {v['number'] or v['invoice_id']}: "
                  f"{line.group(1).strip() if line else 'see Tally'}")
    if done:
        kritvia(c, "/sales/ack", json.dumps({"invoice_ids": [v["invoice_id"] for v in done]}).encode(),
                "application/json")
    print(f"Invoices into Tally: {len(done)} created, {len(failed)} not taken (check ledger names on Kritvia's Money "
          "page: Sales, CGST, SGST, IGST and Round Off must exist in Tally)" if failed else
          f"Invoices into Tally: {len(done)} created")
    return 0 if not failed else 2


if __name__ == "__main__":
    raise SystemExit(main())
