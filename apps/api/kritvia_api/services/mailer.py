"""System email (sign-in codes) — separate from agent messaging, which sends as the
venture's own Gmail after an approval.

MAIL_TRANSPORT:
  smtp    send through SMTP_HOST (Amazon SES SMTP, Zoho, Brevo, Google Workspace relay...)
  log     write the message to the API log instead of sending (single-owner dogfooding:
          read the code with `docker compose logs api`). Never use with outside users.
  memory  keep messages in memory (tests)
"""
from __future__ import annotations

import asyncio
import logging
import smtplib
import ssl
from dataclasses import dataclass, field
from email.message import EmailMessage

from kritvia_api.config import Settings

log = logging.getLogger("kritvia.mailer")


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

    async def send(self, to: str, subject: str, body: str) -> None:
        msg = EmailMessage()
        msg["From"], msg["To"], msg["Subject"] = self.sender, to, subject
        msg.set_content(body)
        if self.transport == "memory":
            self.outbox.append(msg)
        elif self.transport == "log":
            log.warning("MAIL_TRANSPORT=log, not sent. To %s — %s\n%s", to, subject, body)
        else:
            await asyncio.to_thread(self._smtp, msg)

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
        except (OSError, smtplib.SMTPException) as exc:
            raise MailError(f"could not send email: {exc.__class__.__name__}") from None


_mailer: Mailer | None = None


def get_mailer() -> Mailer:
    global _mailer
    if _mailer is None:
        from kritvia_api.config import get_settings
        _mailer = Mailer.from_settings(get_settings())
    return _mailer
