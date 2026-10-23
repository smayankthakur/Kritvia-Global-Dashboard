"""Log redaction: email addresses and phone numbers are masked in every log line the API and the
workers write (logs are archived for a year; the people in them didn't ask to be there).

Installed on the root logger's handlers (and uvicorn's), so it covers records from every module.
Masked: anything that looks like an email address, runs of 10 or more digits (Indian mobiles with
or without +91, account-like numbers), and secrets in request addresses (?k=, &sig=, ?token= and the like). Ids (UUIDs, run ids) and short numbers are left alone.
"""
from __future__ import annotations

import logging
import re

_EMAIL = re.compile(r"[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})+")
# Secrets some providers can only send in a request address (Exotel's Voicebot link, signed stream and
# callback links; test report S14): their values never reach a log line.
_QUERY_SECRET = re.compile(r"(?i)([?&](?:k|sig|token|code|secret|key|signature)=)[^&\s\"']+")
_PHONE = re.compile(r"(?<![\w-])\+?\d[\d -]{8,}\d(?![\w-])")


def redact(text: str) -> str:
    text = _QUERY_SECRET.sub(r"\1…", text)
    text = _EMAIL.sub(lambda m: m.group(0)[0] + "***@" + m.group(0).rsplit("@", 1)[1], text)
    return _PHONE.sub(lambda m: m.group(0) if sum(c.isdigit() for c in m.group(0)) < 10 else "[number]", text)


class RedactFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:  # noqa: BLE001 - a broken format string is logged as it is
            return True
        clean = redact(msg)
        if clean != msg:
            record.msg, record.args = clean, None
        if record.exc_info and not record.exc_text:
            record.exc_text = redact(logging.Formatter().formatException(record.exc_info))
        elif record.exc_text:
            record.exc_text = redact(record.exc_text)
        return True


_installed = False


def install() -> None:
    """Idempotent: adds the filter to the root logger's and uvicorn's handlers."""
    global _installed
    f = RedactFilter()
    names = ("", "uvicorn", "uvicorn.error", "uvicorn.access", "arq", "arq.worker")
    for name in names:
        for h in logging.getLogger(name).handlers:
            if not any(isinstance(x, RedactFilter) for x in h.filters):
                h.addFilter(f)
    _installed = True
