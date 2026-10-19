"""Bank statements: read them, and match each credit to an invoice and each debit to a bill.

A statement comes as the CSV or Excel file every Indian bank's netbanking offers (HDFC, ICICI, SBI, Axis,
Kotak and the rest name their columns differently; the header row is found by its words), or as a PDF,
which is read line by line: a line that starts with a date and ends with amounts is a transaction, and the
running balance tells a credit from a debit.

Code does the arithmetic and the matching, never a model, so the same statement always gives the same
result:

  sure    the amount is what is still owed and the narration names the customer (or supplier), the
          invoice/bill number, or the UPI reference the customer gave on the payment page
  likely  the amount is what is still owed, and only one invoice (or bill) owes exactly that

Nothing is recorded until a person confirms. A password-protected PDF can't be read: download the CSV.
"""
from __future__ import annotations

import csv
import hashlib
import io
import re
import zipfile
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

from defusedxml import ElementTree as ET

MAX_LINES = 5000


class StatementError(Exception):
    pass


@dataclass
class Line:
    day: date
    narration: str
    reference: str | None
    amount_paise: int            # credit > 0, debit < 0
    balance_paise: int | None = None

    @property
    def fingerprint(self) -> str:
        key = f"{self.day.isoformat()}|{self.amount_paise}|{norm(self.narration)}|{(self.reference or '').strip()}"
        return hashlib.sha256(key.encode()).hexdigest()


@dataclass
class Statement:
    lines: list[Line] = field(default_factory=list)

    @property
    def period(self) -> tuple[date | None, date | None]:
        days = [x.day for x in self.lines]
        return (min(days), max(days)) if days else (None, None)

    @property
    def credits(self) -> int:
        return sum(x.amount_paise for x in self.lines if x.amount_paise > 0)

    @property
    def debits(self) -> int:
        return -sum(x.amount_paise for x in self.lines if x.amount_paise < 0)


# ------------------------------------------------------------------------------------------- values --
DATE_FORMATS = ("%d/%m/%Y", "%d/%m/%y", "%d-%m-%Y", "%d-%m-%y", "%d.%m.%Y", "%d.%m.%y", "%Y-%m-%d",
                "%d %b %Y", "%d %b %y", "%d-%b-%Y", "%d-%b-%y", "%d %B %Y", "%b %d, %Y", "%d/%b/%Y")
_DATE_AT_START = re.compile(r"^\s*(\d{1,2}[/\-.](?:\d{1,2}|[A-Za-z]{3})[/\-.]\d{2,4}|\d{4}-\d{2}-\d{2}|"
                            r"\d{1,2} [A-Za-z]{3,9} \d{2,4})")
_AMOUNT = re.compile(r"(?<![\w.])-?\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?(?![\w])|(?<![\w.])-?\d+\.\d{2}(?![\w])")


def parse_date(s: str | None) -> date | None:
    s = re.sub(r"\s+", " ", (s or "").strip())
    if not s:
        return None
    s = s.split(" ")[0] if re.match(r"^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4} \d", s) else s   # "01/10/2026 10:22"
    for fmt in DATE_FORMATS:
        try:
            d = datetime.strptime(s, fmt).date()
        except ValueError:
            continue
        return d if 2000 <= d.year <= 2100 else None
    if re.fullmatch(r"\d{5}(\.\d+)?", s):          # an Excel date serial
        try:
            from datetime import timedelta
            d = date(1899, 12, 30) + timedelta(days=int(float(s)))
            return d if 2000 <= d.year <= 2100 else None
        except (ValueError, OverflowError):
            return None
    return None


def paise(s: str | None) -> int | None:
    """'1,23,456.70' -> 12345670; '' / '-' -> None; '(500.00)' -> -50000; '500.00 Cr' -> 50000."""
    t = (s or "").strip().replace("\u20b9", "").replace("INR", "").replace("Rs.", "").strip()
    neg = t.startswith("(") and t.endswith(")")
    t = t.strip("()").replace(",", "").replace(" ", "")
    t = re.sub(r"(?i)(cr|dr)\.?$", "", t)
    if not t or t in ("-", "--", "0", "0.00", "0.0"):
        return None if t in ("", "-", "--") else 0
    try:
        v = Decimal(t)
    except InvalidOperation:
        return None
    v = -v if neg else v
    return int((v * 100).quantize(Decimal(1)))


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


# ---------------------------------------------------------------------------------------------- CSV --
ROLES = {
    "date": ("txn date", "transaction date", "tran date", "trans date", "posting date", "date", "value date",
             "value dt"),
    "narration": ("narration", "description", "particulars", "transaction remarks", "remarks", "details",
                  "transaction details", "transaction particulars"),
    "reference": ("chq./ref.no.", "ref no./cheque no.", "chq / ref no.", "cheque number", "chq no",
                  "chqno", "ref no", "reference", "utr", "cheque no."),
    "debit": ("withdrawal amt.", "withdrawal amount (inr )", "withdrawal amount", "withdrawal", "debit amount",
              "debit", "dr", "withdrawals", "debit (inr)"),
    "credit": ("deposit amt.", "deposit amount (inr )", "deposit amount", "deposit", "credit amount", "credit",
               "cr", "deposits", "credit (inr)"),
    "amount": ("amount", "transaction amount", "amount (inr)"),
    "drcr": ("dr / cr", "dr/cr", "cr/dr", "type", "debit/credit", "transaction type"),
    "balance": ("closing balance", "balance (inr )", "balance", "bal", "available balance", "running balance"),
}


def _role(header: str) -> str | None:
    h = re.sub(r"\s+", " ", header.strip().lower())
    for role, names in ROLES.items():
        if h in names:
            return role
    for role, names in ROLES.items():          # "Withdrawal Amt (INR)" and the like
        if role in ("date", "narration", "debit", "credit", "balance") and any(
                h.startswith(n) for n in names if len(n) > 3):
            return role
    return None


def _columns(row: list[str]) -> dict[str, int] | None:
    cols: dict[str, int] = {}
    for i, cell in enumerate(row):
        r = _role(cell)
        if r and r not in cols:
            cols[r] = i
    has_money = ("debit" in cols and "credit" in cols) or "amount" in cols
    return cols if "date" in cols and "narration" in cols and has_money else None


def from_rows(rows: list[list[str]]) -> Statement:
    cols = None
    start = 0
    for i, row in enumerate(rows[:60]):
        cols = _columns(row)
        if cols:
            start = i + 1
            break
    if cols is None:
        raise StatementError("couldn't find the statement's columns (date, narration, debit/credit); download "
                             "the statement again as CSV or Excel from your netbanking")
    out = Statement()

    def cell(row: list[str], role: str) -> str:
        i = cols.get(role)
        return row[i].strip() if i is not None and i < len(row) else ""

    for row in rows[start:]:
        if not any(c.strip() for c in row):
            continue
        day = parse_date(cell(row, "date"))
        if day is None:
            continue                            # page footers, totals, "Opening balance" rows
        if "amount" in cols and "debit" not in cols:
            amt = paise(cell(row, "amount"))
            if amt is None:
                continue
            kind = cell(row, "drcr").lower()
            raw = cell(row, "amount").lower()
            if kind.startswith("d") or raw.endswith("dr"):
                amt = -abs(amt)
            elif kind.startswith("c") or raw.endswith("cr"):
                amt = abs(amt)
        else:
            dr, cr = paise(cell(row, "debit")) or 0, paise(cell(row, "credit")) or 0
            amt = abs(cr) - abs(dr)
        if not amt:
            continue
        out.lines.append(Line(day=day, narration=cell(row, "narration")[:500] or "(no narration)",
                              reference=cell(row, "reference")[:120] or None, amount_paise=amt,
                              balance_paise=paise(cell(row, "balance"))))
        if len(out.lines) > MAX_LINES:
            raise StatementError(f"more than {MAX_LINES} lines; upload one month at a time")
    return out


def _csv_rows(data: bytes) -> list[list[str]]:
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            txt = data.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    sample = txt[:5000]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    return [list(r) for r in csv.reader(io.StringIO(txt), dialect)]


# --------------------------------------------------------------------------------------------- XLSX --
_NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def _col_index(ref: str) -> int:
    n = 0
    for ch in re.match(r"[A-Z]+", ref).group(0):  # type: ignore[union-attr]
        n = n * 26 + ord(ch) - 64
    return n - 1


def _xlsx_rows(data: bytes) -> list[list[str]]:
    """The first sheet of an .xlsx file, as text cells (no formulas evaluated; netbanking files have none)."""
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise StatementError("this isn't an Excel (.xlsx) file; an old .xls must be saved as .xlsx or CSV") from None
    if sum(i.file_size for i in z.infolist()) > 80 * 1024 * 1024:
        raise StatementError("this Excel file is too large")
    shared: list[str] = []
    if "xl/sharedStrings.xml" in z.namelist():
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
        for si in root.findall("m:si", _NS):
            shared.append("".join(t.text or "" for t in si.iter("{%s}t" % _NS["m"])))
    sheets = sorted(n for n in z.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n))
    if not sheets:
        raise StatementError("this Excel file has no sheets")
    root = ET.fromstring(z.read(sheets[0]))
    rows: list[list[str]] = []
    for r in root.iter("{%s}row" % _NS["m"]):
        cells: dict[int, str] = {}
        for c in r.findall("m:c", _NS):
            v = c.find("m:v", _NS)
            t = c.get("t")
            if t == "inlineStr":
                val = "".join(x.text or "" for x in c.iter("{%s}t" % _NS["m"]))
            elif v is None:
                continue
            elif t == "s":
                val = shared[int(v.text or 0)] if (v.text or "").isdigit() and int(v.text) < len(shared) else ""
            else:
                val = v.text or ""
            cells[_col_index(c.get("r", "A1"))] = val
        if cells:
            rows.append([cells.get(i, "") for i in range(max(cells) + 1)])
        if len(rows) > MAX_LINES + 100:
            break
    return rows


# ---------------------------------------------------------------------------------------------- PDF --
def from_text(txt: str) -> Statement:
    """Statement lines from a PDF's text: a line starting with a date, ending with amounts; the last amount
    is the running balance, and its change says whether the line was a credit or a debit. A narration that
    wraps onto the next line (with the amounts there) is joined up."""
    out = Statement()
    prev_balance: int | None = None
    pending: Line | None = None
    held: tuple[date, str] | None = None          # a dated line whose amounts are on the next line

    def take(day: date, rest: str) -> bool:
        nonlocal prev_balance, pending
        nums = [n for n in _AMOUNT.findall(rest) if "." in n or "," in n]
        if not nums:
            return False
        balance = paise(nums[-1])
        amount = paise(nums[-2]) if len(nums) >= 2 else None
        if amount is None or balance is None:
            return True
        narration = rest[:rest.find(nums[-2])].strip(" -|")
        sign = 0
        if prev_balance is not None:
            if balance - prev_balance == abs(amount):
                sign = 1
            elif prev_balance - balance == abs(amount):
                sign = -1
        if not sign:
            tail = rest.lower()
            sign = -1 if re.search(r"\bdr\b", tail) else 1 if re.search(r"\bcr\b", tail) else 0
        if not sign:
            return True                                                   # can't tell; better to skip
        prev_balance = balance
        ref = None
        rm = re.search(r"\b(?:UTR|REF|RRN|UPI)[\s:/-]*(?:CR/|DR/)?([A-Z0-9]{8,22})\b", narration, re.I)
        if rm:
            ref = rm.group(1)
        pending = Line(day=day, narration=narration[:500] or "(no narration)", reference=ref,
                       amount_paise=sign * abs(amount), balance_paise=balance)
        out.lines.append(pending)
        if len(out.lines) > MAX_LINES:
            raise StatementError(f"more than {MAX_LINES} lines; upload one month at a time")
        return True

    for raw in txt.splitlines():
        line = raw.strip()
        if not line:
            continue
        low = line.lower()
        if "opening balance" in low or "balance b/f" in low or "brought forward" in low:
            nums = _AMOUNT.findall(line)
            if nums:
                prev_balance = paise(nums[-1])
            continue
        m = _DATE_AT_START.match(line)
        if not m:
            if held is not None:
                day, start = held
                held = None
                if take(day, f"{start} {line}"):
                    continue
            if pending is not None and not _AMOUNT.search(line) and len(pending.narration) < 400:
                pending.narration = f"{pending.narration} {line}"[:500]      # a narration wrapped onto 2 lines
            continue
        day = parse_date(m.group(1))
        rest = line[m.end():].strip()
        rest = _DATE_AT_START.sub("", rest, count=1).strip()               # a value date after the txn date
        if day is None:
            continue
        held = None
        if not take(day, rest):
            held = (day, rest)
    return out


def read(data: bytes, filename: str, pdf_text: str | None = None) -> Statement:
    name = (filename or "").lower()
    if name.endswith(".pdf"):
        if pdf_text is None:
            raise StatementError("the PDF has no readable text")
        st = from_text(pdf_text)
    elif name.endswith(".xlsx") or data[:2] == b"PK":
        st = from_rows(_xlsx_rows(data))
    elif name.endswith(".xls"):
        raise StatementError("save the old .xls file as .xlsx or CSV first (Excel: File → Save As)")
    else:
        st = from_rows(_csv_rows(data))
    if not st.lines:
        raise StatementError("no transactions found in this statement")
    return st


# ----------------------------------------------------------------------------------------- matching --
STOP_WORDS = {"pvt", "ltd", "private", "limited", "the", "and", "llp", "co", "company", "india", "traders",
              "enterprises", "services", "solutions", "shop", "store", "mr", "mrs", "ms", "sri", "shri", "smt",
              "kumar", "bank", "upi", "neft", "imps", "rtgs", "transfer", "payment"}


def name_tokens(name: str) -> list[str]:
    return [t for t in norm(name).split() if len(t) >= 3 and t not in STOP_WORDS and not t.isdigit()]


@dataclass
class Open:
    id: str
    party: str
    number: str
    balance_paise: int
    ref: str | None = None        # the UPI reference a customer gave on the payment page


@dataclass
class Match:
    id: str
    confidence: str               # sure | likely


def mentions(narration: str, o: Open) -> bool:
    text = f" {norm(narration)} "
    squashed = text.replace(" ", "")
    if o.ref and len(o.ref) >= 6 and norm(o.ref).replace(" ", "") in squashed:
        return True
    num = norm(o.number).replace(" ", "")
    if len(num) >= 3 and not num.isdigit() and num in squashed:
        return True
    if len(num) >= 4 and num.isdigit() and re.search(rf"(?<!\d){num}(?!\d)", squashed):
        return True
    toks = name_tokens(o.party)
    if not toks:
        return False
    hits = sum(1 for t in toks if f" {t} " in text or (len(t) >= 5 and t in squashed))
    return hits >= min(2, len(toks))


def match(lines: list[tuple[str, int, str]], invoices: list[Open], bills: list[Open]) -> dict[str, tuple[str, Match]]:
    """lines: (line id, amount paise, narration + reference). Returns line id -> (kind, Match). Each invoice or
    bill is suggested for one line at most; sure matches are placed first."""
    used: set[str] = set()
    out: dict[str, tuple[str, Match]] = {}
    for confident in (True, False):
        for lid, amount, narration in lines:
            if lid in out:
                continue
            kind, pool = ("invoice", invoices) if amount > 0 else ("bill", bills)
            same = [o for o in pool if o.balance_paise == abs(amount) and o.id not in used]
            named = [o for o in same if mentions(narration, o)]
            if confident:
                if len(named) == 1:
                    out[lid] = (kind, Match(named[0].id, "sure"))
                    used.add(named[0].id)
                elif not same:     # a part payment from someone named in the narration
                    part = [o for o in pool if o.id not in used and abs(amount) < o.balance_paise
                            and mentions(narration, o)]
                    if len(part) == 1:
                        out[lid] = (kind, Match(part[0].id, "likely"))
                        used.add(part[0].id)
            elif len(same) == 1:
                out[lid] = (kind, Match(same[0].id, "likely"))
                used.add(same[0].id)
    return out
