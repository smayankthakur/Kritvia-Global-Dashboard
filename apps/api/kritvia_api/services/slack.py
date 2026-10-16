"""Slack for the team: posts to the business's channel when something needs a person.

The owner adds Slack's "Incoming Webhooks" app to a channel and pastes the address it gives into
Settings → Connectors. Kritvia then posts there when a draft waits for a yes and when a customer
chat needs a person, each with a link back to Kritvia. Like push notifications, a post names who
needs attention and never carries what a customer wrote.

Only https://hooks.slack.com/services/... addresses are accepted, and redirects are never followed,
so the server can't be pointed anywhere else. Posting is best effort: a Slack problem never touches
a run, and an address Slack says is gone marks the connector with an error.
"""
from __future__ import annotations

import logging
import re
import uuid
from urllib.parse import urlsplit

import httpx
from sqlalchemy import text

from kritvia_api.config import get_settings
from kritvia_api.db.session import tenant_tx

log = logging.getLogger(__name__)
SECRET = "connector.secret"
_PATH = re.compile(r"^/services/T[A-Z0-9]{6,20}/B[A-Z0-9]{6,20}/[A-Za-z0-9]{16,64}$")


class SlackError(Exception):
    pass


def allowed_webhook(url: str) -> bool:
    try:
        u = urlsplit(url.strip())
    except ValueError:
        return False
    return (u.scheme == "https" and (u.hostname or "").lower() == "hooks.slack.com" and u.port in (None, 443)
            and not u.username and not u.query and not u.fragment and bool(_PATH.match(u.path)))


def _escape(s: str) -> str:
    """Slack's mrkdwn treats &, < and > as markup."""
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def message(title: str, body: str, path: str, business: str | None = None) -> dict:
    link = get_settings().public_web_url.rstrip("/") + path
    head = f"*{_escape(title[:80])}*" + (f"  ·  {_escape(business[:80])}" if business else "")
    lines = [head, _escape(body[:200])] if body else [head]
    return {"text": f"{title[:80]}: {body[:120]}" if body else title[:80],
            "blocks": [{"type": "section", "text": {"type": "mrkdwn", "text": "\n".join(lines)}},
                       {"type": "actions", "elements": [{"type": "button", "text": {"type": "plain_text", "text": "Open in Kritvia"},
                                                          "url": link}]}],
            "unfurl_links": False, "unfurl_media": False}


WEB_API = "https://slack.com/api"
# What Kritvia's Slack app asks for: post and DM (approval cards), find a member by their Kritvia email
# (to link them), and one channel for notices (the installer picks it on Slack's consent screen).
FORM_METHODS = frozenset({"users.lookupByEmail", "users.info"})
APP_SCOPES = "chat:write,im:write,users:read,users:read.email,incoming-webhook"


def verify_signature(signing_secret: str, timestamp: str, body: bytes, signature: str, *, now: float) -> bool:
    """Slack signs every interaction: v0=HMAC-SHA256(secret, "v0:<ts>:<body>"), within 5 minutes."""
    import hashlib
    import hmac
    if not signing_secret or not timestamp.isdigit() or abs(now - int(timestamp)) > 300:
        return False
    mac = hmac.new(signing_secret.encode(), b"v0:" + timestamp.encode() + b":" + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest("v0=" + mac, signature or "")


class SlackClient:
    def __init__(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._http = httpx.AsyncClient(transport=transport, timeout=10, follow_redirects=False)

    async def api(self, token: str, method: str, payload: dict | None = None) -> dict:
        """Slack Web API call with the app's bot token. Raises SlackError unless Slack says ok. Reading
        methods take form fields; writing ones take JSON."""
        headers = {"Authorization": f"Bearer {token}"}
        try:
            if method in FORM_METHODS:
                r = await self._http.post(f"{WEB_API}/{method}", data=payload or {}, headers=headers)
            else:
                r = await self._http.post(f"{WEB_API}/{method}", json=payload or {}, headers=headers)
            data = r.json()
        except (httpx.HTTPError, ValueError):
            raise SlackError("couldn't reach Slack; try again in a minute") from None
        if not isinstance(data, dict) or not data.get("ok"):
            err = str((data or {}).get("error") or r.status_code)[:60] if isinstance(data, dict) else str(r.status_code)
            if err in ("invalid_auth", "account_inactive", "token_revoked", "not_authed"):
                raise SlackError("Kritvia was removed from this Slack workspace; add it to Slack again")
            if err == "users_not_found":
                raise SlackError("no one in this Slack workspace uses your Kritvia email address")
            raise SlackError(f"Slack refused it ({err})")
        return data

    async def oauth_access(self, code: str) -> dict:
        """Swaps the code from "Add to Slack" for the bot token (client credentials in Basic auth)."""
        s = get_settings()
        try:
            r = await self._http.post(f"{WEB_API}/oauth.v2.access", auth=(s.slack_client_id, s.slack_client_secret),
                                      data={"code": code, "redirect_uri": s.slack_redirect_uri})
            data = r.json()
        except (httpx.HTTPError, ValueError):
            raise SlackError("couldn't reach Slack; try again in a minute") from None
        if not isinstance(data, dict) or not data.get("ok") or not data.get("access_token"):
            raise SlackError("Slack didn't finish adding Kritvia; try Add to Slack again")
        return data

    async def post(self, url: str, payload: dict) -> None:
        if not allowed_webhook(url):
            raise SlackError("that isn't a Slack incoming-webhook address (https://hooks.slack.com/services/…)")
        try:
            r = await self._http.post(url, json=payload)
        except httpx.HTTPError:
            raise SlackError("couldn't reach Slack; try again in a minute") from None
        if r.status_code == 200:
            return
        reason = r.text.strip()[:60]
        if r.status_code in (403, 404, 410) or reason in ("no_service", "invalid_token", "channel_not_found",
                                                          "channel_is_archived", "no_team"):
            raise SlackError("Slack says this address no longer works (the webhook was removed or the "
                             "channel archived); add a new one")
        raise SlackError(f"Slack refused the message ({r.status_code} {reason})")


async def _address(venture_id: uuid.UUID):
    """The business's Slack address and connector, read as its agent runtime; None when not connected."""
    from kritvia_api.engine.context import get_services
    from kritvia_api.services.crypto import EnvelopeCrypto
    async with tenant_tx(None, "system") as conn:
        p = (await conn.execute(text("SELECT * FROM private.slack_principal(:v)"), {"v": venture_id})).first()
    if p is None:
        return None
    async with tenant_tx(p.run_as, "agent", "slack") as conn:
        row = (await conn.execute(text(
            "SELECT t.secret_enc, v.name FROM connector_tokens t JOIN ventures v ON v.id = t.venture_id"
            " WHERE t.connector_id = :c"), {"c": p.connector_id})).first()
        if row is None:
            return None
        url = webhook_of(await EnvelopeCrypto(conn, get_services().keys).decrypt_str(venture_id, SECRET, row.secret_enc))
    return (p, url, row.name) if url else None


def secrets_of(stored: str | None) -> dict:
    """The connector's secret: a pasted webhook address, or (Kritvia's Slack app) {"webhook", "bot"}."""
    import json
    if not stored:
        return {}
    if stored.startswith("{"):
        try:
            d = json.loads(stored)
        except ValueError:
            return {}
        return d if isinstance(d, dict) else {}
    return {"webhook": stored}


def webhook_of(stored: str | None) -> str | None:
    return secrets_of(stored).get("webhook") or None


def app_configured() -> bool:
    s = get_settings()
    return bool(s.slack_client_id and s.slack_client_secret and s.slack_signing_secret)


async def app_token(venture_id: uuid.UUID, team: str | None = None):
    """(principal, bot token, team) of Kritvia's Slack app for this business; None when not added."""
    from kritvia_api.engine.context import get_services
    from kritvia_api.services.crypto import EnvelopeCrypto
    async with tenant_tx(None, "system") as conn:
        if team is None:
            p = (await conn.execute(text("SELECT * FROM private.slack_principal(:v)"), {"v": venture_id})).first()
        else:
            p = (await conn.execute(text("SELECT * FROM private.slack_app_principal(:t, :v)"),
                                    {"t": team, "v": venture_id})).first()
    if p is None:
        return None
    async with tenant_tx(p.run_as, "agent", "slack") as conn:
        row = (await conn.execute(text(
            "SELECT c.external_id, c.meta ->> 'mode' AS mode, t.secret_enc FROM connectors c"
            " JOIN connector_tokens t ON t.connector_id = c.id WHERE c.id = :c"), {"c": p.connector_id})).first()
        if row is None or row.mode != "app":
            return None
        bot = secrets_of(await EnvelopeCrypto(conn, get_services().keys).decrypt_str(
            venture_id, SECRET, row.secret_enc)).get("bot")
    return (p, bot, row.external_id) if bot else None


async def notify(venture_id: uuid.UUID, *, title: str, body: str, path: str) -> bool:
    """Posts to the business's Slack channel, if it has one. Never raises."""
    try:
        found = await _address(venture_id)
        if found is None:
            return False
        p, url, business = found
        from kritvia_api.engine.context import get_services
        client = getattr(get_services(), "slack", None) or SlackClient()
        try:
            await client.post(url, message(title, body, path, business))
        except SlackError as exc:
            async with tenant_tx(p.run_as, "agent", "slack") as conn:
                await conn.execute(text("UPDATE connectors SET last_error = :e, updated_at = now() WHERE id = :c"),
                                   {"e": str(exc)[:300], "c": p.connector_id})
            return False
        return True
    except Exception:  # noqa: BLE001 - a Slack post is a courtesy; it must never break the caller
        log.exception("slack post failed for venture %s", venture_id)
        return False
