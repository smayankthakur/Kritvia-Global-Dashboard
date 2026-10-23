"""System email (sign-in codes) — separate from agent messaging, which sends as the
venture's own Gmail after an approval.

Every system email ends with who sent it (legal name, CIN, address). Product emails —
anything a person could reasonably opt out of, such as digests, tips or announcements —
must pass unsubscribe_url: the message then carries a visible unsubscribe link and the
List-Unsubscribe / List-Unsubscribe-Post headers (RFC 2369, RFC 8058) so mail apps show a
one-click Unsubscribe button. Sign-in codes and security notices are transactional and
have no unsubscribe.

MAIL_TRANSPORT:
  smtp    send through SMTP_HOST (Amazon SES SMTP, Zoho, Brevo, Google Workspace relay...)
  log     write the message to the API log instead of sending (single-owner dogfooding:
          read the code with `docker compose logs api`). Never use with outside users.
  memory  keep messages in memory (tests)
"""
from __future__ import annotations

import asyncio
import re
import logging
import smtplib
import ssl
from dataclasses import dataclass, field
from email import policy as _email_policy
from email.message import EmailMessage

from kritvia_api.config import Settings

log = logging.getLogger("kritvia.mailer")

LONG_HEADERS = _email_policy.default.clone(max_line_length=998)



_SECRETISH = re.compile(r"\b\d{6}\b|https?://\S*(?:token|code|link|invite|reset|unsubscribe)\S*", re.I)


def _mask(body: str) -> str:
    """A body for the log: sign-in codes and links that carry a token are replaced."""
    return _SECRETISH.sub("[hidden]", body)

class MailError(Exception):
    pass


@dataclass
class Mailer:
    transport: str
    sender: str
    host: str = ""
    port: int = 587
    username: str = ""
    password: str = ""
    outbox: list[EmailMessage] = field(default_factory=list)

    @classmethod
    def from_settings(cls, s: Settings) -> Mailer:
        if s.mail_transport not in ("smtp", "log", "memory"):
            raise ValueError("MAIL_TRANSPORT must be smtp, log or memory")
        return cls(s.mail_transport, s.mail_from, s.smtp_host, s.smtp_port, s.smtp_username, s.smtp_password)

    @property
    def can_deliver(self) -> bool:
        return self.transport != "smtp" or bool(self.host)

    async def send(self, to: str, subject: str, body: str, *, unsubscribe_url: str | None = None,
                   one_click_url: str | None = None, headers: dict[str, str] | None = None,
                   reply_to: str | None = None) -> None:
        """unsubscribe_url: the page linked in the email; one_click_url: where mail apps POST
        "List-Unsubscribe=One-Click" (defaults to unsubscribe_url). Addresses that hard-bounced or
        complained (SES feedback, routers/ses_feedback.py) are skipped: sending to them gets Kritvia's
        whole SES account suspended, sign-in codes included."""
        if await _suppressed(to):
            log.info("not sending to a suppressed address (bounced or complained)")
            return
        msg = EmailMessage(policy=LONG_HEADERS)   # long URLs in List-Unsubscribe stay plain (no RFC 2047 encoding)
        msg["From"], msg["To"], msg["Subject"] = self.sender, to, subject
        from kritvia_api.config import get_settings
        if reply_to:
            msg["Reply-To"] = reply_to                          # e.g. a person's ask address: their reply asks again
        elif get_settings().support_email:
            msg["Reply-To"] = get_settings().support_email      # replies reach a person, not no-reply@
        for k, v in (headers or {}).items():                   # threading: In-Reply-To / References only
            if k in ("In-Reply-To", "References") and v and "\n" not in v and "\r" not in v:
                msg[k] = v[:300]
        if unsubscribe_url:
            msg["List-Unsubscribe"] = f"<{one_click_url or unsubscribe_url}>"
            msg["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
        msg.set_content(body.rstrip() + "\n\n" + email_footer(unsubscribe_url))
        if self.transport == "memory":
            self.outbox.append(msg)
        elif self.transport == "log":
            # Development only (production refuses MAIL_TRANSPORT=log): codes and links are masked anyway.
            log.warning("MAIL_TRANSPORT=log, not sent. To %s — %s\n%s", to, subject, _mask(body))
        else:
            # A passing SMTP problem (a dropped connection, a 4xx "try later") is tried twice more; a
            # permanent refusal (5xx) isn't.
            for attempt in range(3):
                try:
                    await asyncio.to_thread(self._smtp, msg)
                    return
                except _Transient:
                    if attempt == 2:
                        raise MailError("could not send email: the mail server is not answering; try again") from None
                    await asyncio.sleep(2 if attempt == 0 else 6)

    def _smtp(self, msg: EmailMessage) -> None:
        if not self.host:
            raise MailError("SMTP_HOST is not set")
        try:
            if self.port == 465:
                conn: smtplib.SMTP = smtplib.SMTP_SSL(self.host, self.port, timeout=20,
                                                      context=ssl.create_default_context())
            else:
                conn = smtplib.SMTP(self.host, self.port, timeout=20)
                conn.starttls(context=ssl.create_default_context())
            with conn:
                if self.username:
                    conn.login(self.username, self.password)
                conn.send_message(msg)
        except smtplib.SMTPResponseException as exc:
            if 400 <= exc.smtp_code < 500:
                raise _Transient() from None
            raise MailError(f"could not send email: {exc.__class__.__name__}") from None
        except (smtplib.SMTPServerDisconnected, smtplib.SMTPConnectError, TimeoutError, ConnectionError):
            raise _Transient() from None
        except (OSError, smtplib.SMTPException) as exc:
            raise MailError(f"could not send email: {exc.__class__.__name__}") from None


class _Transient(Exception):
    """A passing SMTP problem: worth another try."""


async def _suppressed(address: str) -> bool:
    try:
        from sqlalchemy import text

        from kritvia_api.db.session import tenant_tx
        async with tenant_tx(None, "system") as conn:
            return bool((await conn.execute(text("SELECT private.email_suppressed(:a)"), {"a": address})).scalar())
    except Exception:  # noqa: BLE001 - the database being down never stops a sign-in code
        return False


def email_footer(unsubscribe_url: str | None = None) -> str:
    """Sender identification for every system email, plus the unsubscribe line for product email."""
    from kritvia_api.config import get_settings
    s = get_settings()
    lines = ["--", f"Kritvia by {s.company_legal_name} (CIN {s.company_cin})",
             s.company_address or "New Delhi, India", f"Questions: {s.support_email}"]
    if unsubscribe_url:
        lines.append(f"Don't want these emails? Unsubscribe in one click: {unsubscribe_url}")
    return "\n".join(lines)


_mailer: Mailer | None = None


def get_mailer() -> Mailer:
    global _mailer
    if _mailer is None:
        from kritvia_api.config import get_settings
        _mailer = Mailer.from_settings(get_settings())
    return _mailer
