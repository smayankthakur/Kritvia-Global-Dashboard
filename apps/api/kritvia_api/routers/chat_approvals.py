"""Approve from your phone: link your Telegram chat or Slack account, and Kritvia's Slack app.

  GET    /ventures/{v}/approver-links            your links (admins: everyone's) and what can be linked
  POST   /ventures/{v}/approver-links/telegram   a one-time t.me link that links the chat it is opened in
  POST   /ventures/{v}/approver-links/slack      a DM in Slack, to the member with your email, to confirm
  DELETE /ventures/{v}/approver-links/{id}       unlink
  POST   /ventures/{v}/connectors/slack/install  "Add to Slack" (admins), bound to this browser by a nonce
  POST   /connectors/slack/complete              the web app's OAuth callback finishes it
  POST   /hooks/slack/interact                   button presses and the "Ask for changes" form (signed)
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlencode

import jwt
from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.config import get_settings
from kritvia_api.db.session import tenant_tx
from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.errors import raise_for_db
from kritvia_api.ratelimit import client_ip, limiter
from kritvia_api.services import chat_approvals, slack
from kritvia_api.services.crypto import EnvelopeCrypto
from kritvia_api.services.quota import PlanRestricted, require_integration
from kritvia_api.services.security_log import security_event

router = APIRouter(tags=["approvals"])
SECRET = "connector.secret"


class ApproverLinkOut(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    person: str
    mine: bool
    channel: str
    label: str | None
    created_at: datetime


class ApproverLinksOut(BaseModel):
    links: list[ApproverLinkOut]
    telegram_bot: str | None = Field(description="the business's bot (@username) when Telegram is connected")
    slack_app: bool = Field(description="Kritvia's Slack app is added to this business's Slack")
    slack_available: bool = Field(description="this server has Kritvia's Slack app, so it can be added")
    can_add_slack: bool = Field(description="the caller may add Kritvia to Slack (business admins)")


@router.get("/ventures/{venture_id}/approver-links", response_model=ApproverLinksOut)
async def list_links(venture_id: uuid.UUID, user_id: UserId, db: TenantDB) -> ApproverLinksOut:
    await venture_org(db, venture_id)
    rows = (await db.execute(text(
        "SELECT l.id, l.user_id, coalesce(nullif(u.full_name, ''), u.email) AS person, l.channel, l.label, l.created_at"
        " FROM approver_links l JOIN users u ON u.id = l.user_id WHERE l.venture_id = :v ORDER BY l.created_at"),
        {"v": venture_id})).all()
    conns = (await db.execute(text(
        "SELECT provider, account_email, meta ->> 'mode' AS mode FROM connectors"
        " WHERE venture_id = :v AND provider IN ('telegram', 'slack') AND status = 'active'"), {"v": venture_id})).all()
    admin = bool((await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar())
    bot = next((c.account_email for c in conns if c.provider == "telegram"), None)
    return ApproverLinksOut(
        links=[ApproverLinkOut(id=r.id, user_id=r.user_id, person=r.person, mine=r.user_id == user_id,
                               channel=r.channel, label=r.label, created_at=r.created_at) for r in rows],
        telegram_bot=bot, slack_app=any(c.provider == "slack" and c.mode == "app" for c in conns),
        slack_available=slack.app_configured(), can_add_slack=admin)


async def _new_code(db, venture_id: uuid.UUID, channel: str) -> str:
    code = chat_approvals.new_code()
    try:
        async with db.begin_nested():
            await db.execute(text("SELECT private.new_approver_link_code(:v, :c, :h)"),
                             {"v": venture_id, "c": channel, "h": chat_approvals.code_hash(code)})
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    return code


class TelegramLinkOut(BaseModel):
    link: str = Field(description="open on the phone with Telegram; works once, for 15 minutes")
    bot: str


@router.post("/ventures/{venture_id}/approver-links/telegram", response_model=TelegramLinkOut)
async def link_telegram(venture_id: uuid.UUID, user_id: UserId, db: TenantDB, svc: Svc) -> TelegramLinkOut:
    await venture_org(db, venture_id)
    await limiter.hit(f"approver-link:{user_id}", per_minute=10)
    bot = (await db.execute(text(
        "SELECT account_email FROM connectors WHERE venture_id = :v AND provider = 'telegram' AND status = 'active'"),
        {"v": venture_id})).scalar()
    if not bot:
        raise HTTPException(status.HTTP_409_CONFLICT, "Connect the business's Telegram bot first (Settings → Connectors)")
    try:
        await require_integration(db, venture_id, "telegram")
    except PlanRestricted as exc:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, str(exc)) from None
    from kritvia_api.services.telegram import TelegramError
    try:
        await chat_approvals.ensure_buttons(venture_id, svc)
    except TelegramError as exc:
        raise HTTPException(422, str(exc)) from None
    code = await _new_code(db, venture_id, "telegram")
    username = bot.lstrip("@")
    return TelegramLinkOut(link=f"https://t.me/{username}?start={chat_approvals.LINK_PREFIX}{code}", bot="@" + username)


class SlackLinkOut(BaseModel):
    sent_to: str = Field(description="who in Slack got the confirmation message")


@router.post("/ventures/{venture_id}/approver-links/slack", response_model=SlackLinkOut)
async def link_slack(venture_id: uuid.UUID, user_id: UserId, db: TenantDB, svc: Svc) -> SlackLinkOut:
    """Finds the Slack member with your Kritvia email and sends them a "Link to Kritvia" button. Pressing
    it from that Slack account links it, so an email match alone never links anyone."""
    await venture_org(db, venture_id)
    await limiter.hit(f"approver-link:{user_id}", per_minute=10)
    app = await slack.app_token(venture_id) if slack.app_configured() else None
    if app is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Add Kritvia to the business's Slack first (Settings → Connectors)")
    email = (await db.execute(text("SELECT email FROM users WHERE id = :u"), {"u": user_id})).scalar()
    code = await _new_code(db, venture_id, "slack")
    name = (await db.execute(text("SELECT name FROM ventures WHERE id = :v"), {"v": venture_id})).scalar()
    try:
        found = await svc.slack.api(app[1], "users.lookupByEmail", {"email": email})
        member = found.get("user") or {}
        await svc.slack.api(app[1], "chat.postMessage", {
            "channel": member["id"], "text": "Link your Slack to Kritvia?",
            "blocks": [{"type": "section", "text": {"type": "mrkdwn", "text": slack._escape(
                f"You asked Kritvia to send drafts for {name} that need your yes here. Press Link to confirm "
                "it's you (the button works for 15 minutes).")}},
                       {"type": "actions", "elements": [{"type": "button", "action_id": "kv_link", "style": "primary",
                                                         "text": {"type": "plain_text", "text": "Link"},
                                                         "value": f"{venture_id}:{code}"}]}]})
    except slack.SlackError as exc:
        raise HTTPException(422, str(exc)) from None
    except KeyError:
        raise HTTPException(422, "no one in this Slack workspace uses your Kritvia email address") from None
    return SlackLinkOut(sent_to=str(member.get("real_name") or member.get("name") or "you")[:120])


@router.delete("/ventures/{venture_id}/approver-links/{link_id}", status_code=204)
async def unlink(venture_id: uuid.UUID, link_id: uuid.UUID, db: TenantDB) -> None:
    gone = (await db.execute(text("DELETE FROM approver_links WHERE id = :l AND venture_id = :v RETURNING id"),
                             {"l": link_id, "v": venture_id})).first()
    if gone is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "link not found")


# ----------------------------------------------------------- Kritvia's Slack app --
class SlackInstallIn(BaseModel):
    nonce: str = Field(min_length=32, max_length=128)


class AuthUrlOut(BaseModel):
    url: str


def _nonce_hash(nonce: str) -> str:
    return hashlib.sha256(("slack-oauth|" + nonce).encode()).hexdigest()


@router.post("/ventures/{venture_id}/connectors/slack/install", response_model=AuthUrlOut)
async def slack_install(venture_id: uuid.UUID, body: SlackInstallIn, user_id: UserId, db: TenantDB) -> AuthUrlOut:
    await venture_org(db, venture_id)
    if not (await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "venture not found")
    if not slack.app_configured():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Kritvia's Slack app is not set up on this server")
    try:
        await require_integration(db, venture_id, "slack")
    except PlanRestricted as exc:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, str(exc)) from None
    s = get_settings()
    state = jwt.encode({"typ": "slack", "v": str(venture_id), "u": str(user_id), "nh": _nonce_hash(body.nonce),
                        "exp": datetime.now(UTC) + timedelta(minutes=10)}, s.jwt_secret, algorithm=s.jwt_algorithm)
    query = urlencode({"client_id": s.slack_client_id, "scope": slack.APP_SCOPES, "state": state,
                       "redirect_uri": s.slack_redirect_uri})
    return AuthUrlOut(url=f"https://slack.com/oauth/v2/authorize?{query}")


class SlackCompleteIn(BaseModel):
    code: str = Field(min_length=1, max_length=2000)
    state: str = Field(min_length=1, max_length=4000)
    nonce: str = Field(min_length=32, max_length=128)


class SlackCompleteOut(BaseModel):
    venture_id: uuid.UUID
    team: str | None
    channel: str | None


@router.post("/connectors/slack/complete", response_model=SlackCompleteOut)
async def slack_complete(body: SlackCompleteIn, user_id: UserId, svc: Svc) -> SlackCompleteOut:
    """Called by the web app's OAuth callback with the code, the state and the nonce from ITS httpOnly
    cookie, as the signed-in user. Stores the bot token encrypted, keeps the channel the installer picked
    for notices, and links the installer's own Slack account (they just proved it by adding the app)."""
    s = get_settings()
    try:
        st = jwt.decode(body.state, s.jwt_secret, algorithms=[s.jwt_algorithm], options={"require": ["exp", "typ"]})
        if st["typ"] != "slack":
            raise jwt.InvalidTokenError()
        venture_id, state_user = uuid.UUID(st["v"]), uuid.UUID(st["u"])
    except (jwt.PyJWTError, KeyError, ValueError):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid or expired Slack state") from None
    if state_user != user_id or not hmac.compare_digest(st.get("nh", ""), _nonce_hash(body.nonce)):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "this Slack authorisation was not started in this session")
    if not slack.app_configured():
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Kritvia's Slack app is not set up on this server")
    try:
        tok = await svc.slack.oauth_access(body.code)
    except slack.SlackError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from None
    team = tok.get("team") or {}
    hook = tok.get("incoming_webhook") or {}
    webhook = hook.get("url") if isinstance(hook.get("url"), str) and slack.allowed_webhook(hook["url"]) else None
    channel = str(hook.get("channel") or "")[:80] or None
    team_id = str(team.get("id") or "")[:64]
    if not team_id:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Slack didn't say which workspace it was added to")
    async with tenant_tx(user_id) as conn:
        org = await venture_org(conn, venture_id)
        if not (await conn.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar():
            raise HTTPException(status.HTTP_404_NOT_FOUND, "venture not found")
        try:
            async with conn.begin_nested():
                cid = (await conn.execute(text(
                    "INSERT INTO connectors (org_id, venture_id, provider, account_email, external_id, scopes, meta, created_by)"
                    " VALUES (:o, :v, 'slack', :ch, :t, :sc, CAST(:m AS jsonb), :u)"
                    " ON CONFLICT (venture_id, provider) DO UPDATE SET status = 'active', account_email = EXCLUDED.account_email,"
                    " external_id = EXCLUDED.external_id, scopes = EXCLUDED.scopes, meta = connectors.meta || EXCLUDED.meta,"
                    " last_error = NULL, updated_at = now() RETURNING id"),
                    {"o": org, "v": venture_id, "ch": channel, "t": team_id,
                     "sc": [x for x in str(tok.get("scope") or "").split(",") if x][:20],
                     "m": json.dumps({"mode": "app", "team_name": str(team.get("name") or "")[:80]}),
                     "u": user_id})).scalar_one()
                enc = await EnvelopeCrypto(conn, svc.keys).encrypt(
                    venture_id, SECRET, json.dumps({"bot": tok["access_token"], "webhook": webhook}))
                await conn.execute(text(
                    "INSERT INTO connector_tokens (connector_id, org_id, venture_id, secret_enc) VALUES (:c, :o, :v, :s)"
                    " ON CONFLICT (connector_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, updated_at = now()"),
                    {"c": cid, "o": org, "v": venture_id, "s": enc})
                installer = str((tok.get("authed_user") or {}).get("id") or "")[:64]
                if installer:
                    code = chat_approvals.new_code()
                    h = chat_approvals.code_hash(code)
                    await conn.execute(text("SELECT private.new_approver_link_code(:v, 'slack', :h)"),
                                       {"v": venture_id, "h": h})
                    await conn.execute(text(
                        "SELECT * FROM private.redeem_approver_link_code(:v, 'slack', :h, :x, :t, :l)"),
                        {"v": venture_id, "h": h, "x": installer, "t": team_id, "l": "Slack"})
        except DBAPIError as exc:
            raise_for_db(exc, "venture not found")
    return SlackCompleteOut(venture_id=venture_id, team=str(team.get("name") or "")[:80] or None, channel=channel)


@router.post("/hooks/slack/interact", response_model=None)
async def slack_interact(request: Request, svc: Svc) -> Response:
    """Kritvia's Slack app: a button press or a submitted form. Slack signs each request with the app's
    signing secret; anything unsigned, stale or replayed outside five minutes is refused."""
    await limiter.hit(f"hook-ip:{client_ip(request)}", per_minute=600)
    body = await request.body()
    if len(body) > 64 * 1024:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "payload too large")
    if not slack.verify_signature(get_settings().slack_signing_secret, request.headers.get("x-slack-request-timestamp", ""),
                                  body, request.headers.get("x-slack-signature", ""), now=time.time()):
        await security_event("webhook.bad_signature", "warning", request=request, provider="slack")
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad signature")
    try:
        payload = json.loads(parse_qs(body.decode())["payload"][0])
    except (KeyError, IndexError, ValueError, UnicodeDecodeError):
        raise HTTPException(422, "expected a Slack interaction") from None
    if not isinstance(payload, dict):
        raise HTTPException(422, "expected a Slack interaction")
    out = await chat_approvals.slack_interaction(payload, svc)
    if out is None:
        return Response(status_code=200)
    return Response(content=json.dumps(out), media_type="application/json")
