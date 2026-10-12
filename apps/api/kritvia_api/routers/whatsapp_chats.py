"""The WhatsApp page: a business's customer chats, read and answered by its team.

Kritvia drafts replies for every chat it handles (inbox assistant). A person can take a chat over
at any time, and does so automatically by replying here; Kritvia then stays quiet in that chat
until someone gives it back. Typed messages can only be sent within WhatsApp's 24-hour window;
to write first, or after 24 hours, the team sends one of the business's approved templates.
"""
from __future__ import annotations

import uuid
from datetime import datetime
import re
from dataclasses import dataclass
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.db.session import tenant_tx
from kritvia_api.deps import Svc, TenantDB, TenantDBCommitFirst, UserId, venture_org
from kritvia_api.errors import raise_for_db
from kritvia_api.services import push, wa_inbox
from kritvia_api.services.crypto import EnvelopeCrypto
from kritvia_api.services.quota import PlanRestricted, require_integration
from kritvia_api.services.whatsapp import (WhatsAppConn, WhatsAppError, check_param, check_template_body,
                                           render_template, template_params)

router = APIRouter(tags=["whatsapp"])


class ChatOut(BaseModel):
    id: uuid.UUID
    phone: str
    name: str | None
    handled_by: Literal["kritvia", "person"]
    handoff_reason: str | None
    opted_out: bool
    unread: int
    window_open: bool = Field(description="false once 24 hours have passed since the customer last wrote")
    last_message_at: datetime
    last_message: str
    last_direction: Literal["in", "out"] | None
    lead_id: uuid.UUID | None
    pending_approval_id: uuid.UUID | None = Field(description="a reply Kritvia drafted that waits for a yes")


class ChatsOut(BaseModel):
    connected: bool
    number: str | None
    chats: list[ChatOut]


class MessageOut(BaseModel):
    id: uuid.UUID
    direction: Literal["in", "out"]
    sent_by: Literal["customer", "kritvia", "person", "phone"]
    kind: str
    body: str
    status: Literal["received", "sent", "failed"]
    error: str | None
    created_at: datetime


class ChatDetailOut(BaseModel):
    chat: ChatOut
    messages: list[MessageOut]


class ReplyIn(BaseModel):
    body: str = Field(min_length=1, max_length=4096)


class HandlerIn(BaseModel):
    handled_by: Literal["kritvia", "person"]


CHAT_SQL = (
    "SELECT c.id, c.phone, c.name, c.handled_by, c.handoff_reason, c.opted_out_at, c.unread, c.last_inbound_at,"
    " c.last_message_at, c.lead_id, m.body_enc, m.direction,"
    " (SELECT a.id FROM approvals a JOIN workflow_runs r ON r.id = a.run_id"
    "   JOIN wa_messages i ON i.venture_id = r.venture_id AND i.provider_message_id = r.trigger_ref"
    "  WHERE i.contact_id = c.id AND r.trigger_kind = 'whatsapp' AND a.status = 'pending'"
    "  ORDER BY a.created_at DESC LIMIT 1) AS pending_id"
    " FROM wa_contacts c LEFT JOIN LATERAL (SELECT body_enc, direction FROM wa_messages"
    "   WHERE contact_id = c.id ORDER BY created_at DESC, id DESC LIMIT 1) m ON true"
    " WHERE c.venture_id = :v")


async def _chat(crypto: EnvelopeCrypto, venture_id: uuid.UUID, r) -> ChatOut:
    last = (await crypto.decrypt_str(venture_id, wa_inbox.PURPOSE, r.body_enc) or "") if r.body_enc else ""
    return ChatOut(id=r.id, phone=r.phone, name=r.name, handled_by=r.handled_by, handoff_reason=r.handoff_reason,
                   opted_out=r.opted_out_at is not None, unread=r.unread,
                   window_open=wa_inbox.window_open(r.last_inbound_at), last_message_at=r.last_message_at,
                   last_message=last[:140], last_direction=r.direction, lead_id=r.lead_id,
                   pending_approval_id=r.pending_id)


async def _one(db, venture_id: uuid.UUID, chat_id: uuid.UUID):
    await venture_org(db, venture_id)                       # 404 for a business the caller can't see
    r = (await db.execute(text(CHAT_SQL + " AND c.id = :id"), {"v": venture_id, "id": chat_id})).first()
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "chat not found")
    return r


async def _can_write(db, venture_id: uuid.UUID) -> None:
    if not (await db.execute(text("SELECT :v = ANY (private.writable_ventures())"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "your role can read chats but not answer them")


@dataclass
class _Sender:
    conn: WhatsAppConn
    org_id: uuid.UUID
    run_as: uuid.UUID
    waba_id: str | None


async def _sender(db, svc, venture_id: uuid.UUID) -> _Sender:
    """The business's WhatsApp number and token. The token is readable only by the agent runtime and
    admins, so it is read as the runtime; sends happen on the person's behalf."""
    c = (await db.execute(text(
        "SELECT external_id, meta ->> 'waba_id' AS waba FROM connectors"
        " WHERE venture_id = :v AND provider = 'whatsapp' AND status = 'active'"), {"v": venture_id})).first()
    if c is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "connect WhatsApp in Settings → Connectors first")
    p = (await db.execute(text("SELECT * FROM private.whatsapp_principal(:p)"), {"p": c.external_id})).first()
    if p is None or p.venture_id != venture_id:
        raise HTTPException(status.HTTP_409_CONFLICT, "connect WhatsApp in Settings → Connectors first")
    async with tenant_tx(p.run_as, "agent", "whatsapp") as rconn:
        tok = (await rconn.execute(text("SELECT secret_enc FROM connector_tokens WHERE connector_id = :c"),
                                   {"c": p.connector_id})).scalar()
        token = await EnvelopeCrypto(rconn, svc.keys).decrypt_str(venture_id, "connector.secret", tok) if tok else None
    if not token:
        raise HTTPException(status.HTTP_409_CONFLICT, "reconnect WhatsApp in Settings → Connectors")
    return _Sender(WhatsAppConn(p.connector_id, c.external_id, None, token), p.org_id, p.run_as, c.waba or None)


async def _plan_ok(db, venture_id: uuid.UUID) -> None:
    try:
        await require_integration(db, venture_id, "whatsapp")
    except PlanRestricted as exc:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, str(exc)) from None


@router.get("/ventures/{venture_id}/whatsapp/chats", response_model=ChatsOut)
async def list_chats(venture_id: uuid.UUID, svc: Svc, db: TenantDB, limit: int = 50) -> ChatsOut:
    await venture_org(db, venture_id)
    conn_row = (await db.execute(text(
        "SELECT account_email FROM connectors WHERE venture_id = :v AND provider = 'whatsapp' AND status = 'active'"),
        {"v": venture_id})).first()
    rows = (await db.execute(text(CHAT_SQL + " ORDER BY c.last_message_at DESC LIMIT :l"),
                             {"v": venture_id, "l": min(max(limit, 1), 200)})).all()
    crypto = EnvelopeCrypto(db, svc.keys)
    return ChatsOut(connected=conn_row is not None, number=conn_row.account_email if conn_row else None,
                    chats=[await _chat(crypto, venture_id, r) for r in rows])


@router.get("/ventures/{venture_id}/whatsapp/chats/{chat_id}", response_model=ChatDetailOut)
async def get_chat(venture_id: uuid.UUID, chat_id: uuid.UUID, svc: Svc, db: TenantDB) -> ChatDetailOut:
    r = await _one(db, venture_id, chat_id)
    crypto = EnvelopeCrypto(db, svc.keys)
    msgs = await wa_inbox.thread(db, crypto, venture_id, chat_id, limit=200)
    await db.execute(text("SELECT private.wa_mark_read(:c)"), {"c": chat_id})
    chat = await _chat(crypto, venture_id, r)
    return ChatDetailOut(chat=chat.model_copy(update={"unread": 0}), messages=[MessageOut(**m) for m in msgs])


@router.post("/ventures/{venture_id}/whatsapp/chats/{chat_id}/reply", response_model=MessageOut, status_code=201)
async def reply(venture_id: uuid.UUID, chat_id: uuid.UUID, body: ReplyIn, user_id: UserId, svc: Svc,
                db: TenantDBCommitFirst, background: BackgroundTasks) -> MessageOut:
    """A person answers the customer now. Kritvia steps back from this chat until it is given back."""
    r = await _one(db, venture_id, chat_id)
    await _can_write(db, venture_id)
    await _plan_ok(db, venture_id)
    if r.opted_out_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "this customer asked not to receive messages (they wrote STOP)")
    if not wa_inbox.window_open(r.last_inbound_at):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "the customer last wrote more than 24 hours ago; send an approved template instead")
    snd = await _sender(db, svc, venture_id)
    text_ = body.body.strip()
    crypto = EnvelopeCrypto(db, svc.keys)
    try:
        mid = await svc.whatsapp.send_text(snd.conn, to=r.phone, body=text_)
        status_, error = "sent", None
    except WhatsAppError as exc:
        mid, status_, error = None, "failed", str(exc)
    try:
        await wa_inbox.record_outbound(db, crypto, org_id=snd.org_id, venture_id=venture_id, phone=r.phone,
                                       body=text_, sent_by="person", status=status_, provider_id=mid, error=error,
                                       user_id=user_id)
        if r.handled_by == "kritvia" and not error:
            await wa_inbox.hand_to_person(db, venture_id, chat_id, "A person replied")
        waiting = await wa_inbox.waiting_runs(db, venture_id, chat_id) if not error else []
    except DBAPIError as exc:
        raise_for_db(exc, "chat not found")
    if error:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, error)
    # The customer has their answer: a draft Kritvia made for this chat would be a second one. It is
    # withdrawn once this reply is saved (cancelling takes locks this transaction must not wait on).
    if waiting:
        background.add_task(wa_inbox.withdraw_drafts, snd.run_as, waiting)
    m = (await wa_inbox.thread(db, crypto, venture_id, chat_id, limit=1))[-1]
    return MessageOut(**m)


@router.put("/ventures/{venture_id}/whatsapp/chats/{chat_id}/handler", response_model=ChatOut)
async def set_handler(venture_id: uuid.UUID, chat_id: uuid.UUID, body: HandlerIn, svc: Svc,
                      db: TenantDB) -> ChatOut:
    """Take a chat over ("person") or give it back to Kritvia ("kritvia")."""
    await _one(db, venture_id, chat_id)
    await _can_write(db, venture_id)
    if body.handled_by == "person":
        await wa_inbox.hand_to_person(db, venture_id, chat_id, "Taken over by the team")
    else:
        await db.execute(text(
            "UPDATE wa_contacts SET handled_by = 'kritvia', handoff_reason = NULL, handoff_at = NULL,"
            " updated_at = now() WHERE id = :id AND venture_id = :v"), {"id": chat_id, "v": venture_id})
    return await _chat(EnvelopeCrypto(db, svc.keys), venture_id, await _one(db, venture_id, chat_id))


@router.delete("/ventures/{venture_id}/whatsapp/chats/{chat_id}", status_code=204)
async def delete_chat(venture_id: uuid.UUID, chat_id: uuid.UUID, db: TenantDB) -> None:
    """Erase a customer's chat and every message in it (e.g. when they ask for their data to be deleted)."""
    await _one(db, venture_id, chat_id)
    if not (await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only the business's admins can delete a chat")
    await db.execute(text("DELETE FROM wa_contacts WHERE id = :id AND venture_id = :v"), {"id": chat_id, "v": venture_id})


# --- Templates: messages WhatsApp approved in advance, for writing first or after 24 hours ------
class TemplateOut(BaseModel):
    id: uuid.UUID
    name: str
    language: str
    category: Literal["MARKETING", "UTILITY", "AUTHENTICATION"]
    body: str
    params: int = Field(description="number of blanks to fill in: {{1}}, {{2}}, …")
    examples: list[str]
    status: str = Field(description="PENDING while Meta reviews it; only APPROVED templates can be sent")
    reason: str | None = Field(description="why Meta rejected or paused it")
    sendable: bool = Field(description="false when it needs a photo, link blank or code; send those from WhatsApp Manager")
    updated_at: datetime


class TemplatesOut(BaseModel):
    connected: bool
    manageable: bool = Field(description="false when Kritvia doesn't know the WhatsApp account; reconnect with the button")
    templates: list[TemplateOut]


class TemplateIn(BaseModel):
    label: str = Field(min_length=1, max_length=60, description="a name for the team, e.g. 'Order ready'")
    language: Literal["en", "en_US", "en_GB", "hi"] = "en"
    category: Literal["UTILITY", "MARKETING"]
    body: str = Field(min_length=1, max_length=1024)
    examples: list[str] = Field(default_factory=list, max_length=20,
                                description="a sample for each blank, in order; Meta's reviewers read them")


class SendTemplateIn(BaseModel):
    template_id: uuid.UUID
    params: list[str] = Field(default_factory=list, max_length=20)


class NewChatIn(SendTemplateIn):
    phone: str = Field(min_length=8, max_length=24,
                       description="with country code, e.g. +91 98111 22233 (a 10-digit Indian mobile also works)")
    name: str | None = Field(default=None, max_length=120)
    consent: Literal[True] = Field(description="this person agreed to get WhatsApp messages from the business")


TPL_COLS = "id, name, language, category, body, params, examples, status, reason, sendable, updated_at, meta_id"


def slug(label: str) -> str:
    """'Order ready!' → 'order_ready' (Meta allows lowercase letters, digits and underscores)."""
    s = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")
    return (s or "message")[:60]


async def _can_admin(db, venture_id: uuid.UUID) -> None:
    if not (await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only the business's admins can do this")


async def _templates(db, venture_id: uuid.UUID) -> list[TemplateOut]:
    rows = (await db.execute(text(f"SELECT {TPL_COLS} FROM wa_templates WHERE venture_id = :v"
                                  " ORDER BY (status = 'APPROVED') DESC, updated_at DESC"), {"v": venture_id})).all()
    return [TemplateOut(**{k: getattr(r, k) for k in TemplateOut.model_fields}) for r in rows]


async def _sync(db, svc, venture_id: uuid.UUID, snd: _Sender) -> None:
    """Mirror the WhatsApp account's templates (including ones written in WhatsApp Manager)."""
    try:
        found = await svc.whatsapp.list_templates(snd.waba_id, snd.conn.access_token)
    except WhatsAppError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from None
    for t in found:
        await db.execute(text(
            "INSERT INTO wa_templates (org_id, venture_id, meta_id, name, language, category, body, params, examples,"
            " sendable, status, reason) VALUES (:o, :v, :id, :n, :l, :c, :b, :p, :e, :s, :st, :r)"
            " ON CONFLICT (venture_id, name, language) DO UPDATE SET meta_id = EXCLUDED.meta_id,"
            " category = EXCLUDED.category, body = EXCLUDED.body, params = EXCLUDED.params,"
            " examples = EXCLUDED.examples, sendable = EXCLUDED.sendable, status = EXCLUDED.status,"
            " reason = EXCLUDED.reason, updated_at = now()"),
            {"o": snd.org_id, "v": venture_id, "id": t.meta_id, "n": t.name, "l": t.language, "c": t.category,
             "b": t.body, "p": min(t.params, 20), "e": t.examples, "s": t.sendable, "st": t.status, "r": t.reason})
    # Templates deleted in WhatsApp Manager disappear here too.
    keep = [f"{t.name}|{t.language}" for t in found]
    await db.execute(text("DELETE FROM wa_templates WHERE venture_id = :v AND meta_id IS NOT NULL"
                          " AND NOT (name || '|' || language = ANY (CAST(:k AS text[])))"), {"v": venture_id, "k": keep})


@router.get("/ventures/{venture_id}/whatsapp/templates", response_model=TemplatesOut)
async def list_templates(venture_id: uuid.UUID, svc: Svc, db: TenantDB, refresh: bool = False) -> TemplatesOut:
    """The business's templates. `refresh` reads the latest from WhatsApp first (team members who can write)."""
    await venture_org(db, venture_id)
    c = (await db.execute(text(
        "SELECT meta ->> 'waba_id' AS waba FROM connectors WHERE venture_id = :v AND provider = 'whatsapp'"
        " AND status = 'active'"), {"v": venture_id})).first()
    if refresh and c is not None and c.waba:
        await _can_write(db, venture_id)
        await _sync(db, svc, venture_id, await _sender(db, svc, venture_id))
    return TemplatesOut(connected=c is not None, manageable=bool(c and c.waba), templates=await _templates(db, venture_id))


@router.post("/ventures/{venture_id}/whatsapp/templates", response_model=TemplateOut, status_code=201)
async def create_template(venture_id: uuid.UUID, body: TemplateIn, user_id: UserId, svc: Svc,
                          db: TenantDB) -> TemplateOut:
    """Writes a template and sends it to Meta for review (usually minutes, at most a day)."""
    await venture_org(db, venture_id)
    await _can_write(db, venture_id)
    await _plan_ok(db, venture_id)
    text_ = body.body.strip()
    if problem := check_template_body(text_):
        raise HTTPException(422, problem)
    n = template_params(text_)
    examples = [e.strip() for e in body.examples[:n]]
    if len(examples) < n or any(check_param(e) for e in examples):
        raise HTTPException(422, "give a sample for every blank (no new lines), so Meta's reviewers understand it")
    snd = await _sender(db, svc, venture_id)
    if not snd.waba_id:
        raise HTTPException(status.HTTP_409_CONFLICT, "reconnect WhatsApp with the Connect WhatsApp button to write templates")
    name = slug(body.label)
    if (await db.execute(text("SELECT 1 FROM wa_templates WHERE venture_id = :v AND name = :n AND language = :l"),
                         {"v": venture_id, "n": name, "l": body.language})).first():
        raise HTTPException(status.HTTP_409_CONFLICT, "a template with this name and language already exists; pick another name")
    try:
        meta_id, st, category = await svc.whatsapp.create_template(
            snd.waba_id, snd.conn.access_token, name=name, language=body.language, category=body.category,
            body=text_, examples=examples)
    except WhatsAppError as exc:
        raise HTTPException(422, str(exc)) from None
    category = category if category in ("MARKETING", "UTILITY", "AUTHENTICATION") else body.category
    r = (await db.execute(text(
        "INSERT INTO wa_templates (org_id, venture_id, meta_id, name, language, category, body, params, examples,"
        " status, created_by) VALUES (:o, :v, :id, :n, :l, :c, :b, :p, :e, :st, :u)"
        f" RETURNING {TPL_COLS}"),
        {"o": snd.org_id, "v": venture_id, "id": meta_id or None, "n": name, "l": body.language, "c": category,
         "b": text_, "p": n, "e": examples, "st": st, "u": user_id})).first()
    return TemplateOut(**{k: getattr(r, k) for k in TemplateOut.model_fields})


@router.delete("/ventures/{venture_id}/whatsapp/templates/{template_id}", status_code=204)
async def delete_template(venture_id: uuid.UUID, template_id: uuid.UUID, svc: Svc, db: TenantDB) -> None:
    """Deletes the template from the WhatsApp account too. Meta keeps the name blocked for 30 days."""
    await venture_org(db, venture_id)
    await _can_admin(db, venture_id)
    t = (await db.execute(text("SELECT name, meta_id FROM wa_templates WHERE id = :id AND venture_id = :v"),
                          {"id": template_id, "v": venture_id})).first()
    if t is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "template not found")
    snd = await _sender(db, svc, venture_id)
    if snd.waba_id:
        try:
            await svc.whatsapp.delete_template(snd.waba_id, snd.conn.access_token, name=t.name, meta_id=t.meta_id)
        except WhatsAppError as exc:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from None
    await db.execute(text("DELETE FROM wa_templates WHERE id = :id AND venture_id = :v"),
                     {"id": template_id, "v": venture_id})


async def _send_template(db, svc, venture_id: uuid.UUID, user_id: uuid.UUID, *, phone: str, name: str | None,
                         body: SendTemplateIn) -> str:
    """Sends an approved template and records it in the chat. Returns the rendered text."""
    t = (await db.execute(text(f"SELECT {TPL_COLS} FROM wa_templates WHERE id = :id AND venture_id = :v"),
                          {"id": body.template_id, "v": venture_id})).first()
    if t is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "template not found")
    if t.status != "APPROVED":
        raise HTTPException(status.HTTP_409_CONFLICT, "WhatsApp hasn't approved this template yet")
    if not t.sendable:
        raise HTTPException(status.HTTP_409_CONFLICT, "this template needs a photo, link or code; send it from WhatsApp Manager")
    params = [p.strip() for p in body.params]
    if len(params) != t.params:
        raise HTTPException(422, f"fill in all {t.params} blank(s)")
    for p in params:
        if problem := check_param(p):
            raise HTTPException(422, problem)
    snd = await _sender(db, svc, venture_id)
    rendered = render_template(t.body, params)
    try:
        mid = await svc.whatsapp.send_template(snd.conn, to=phone, name=t.name, language=t.language, params=params)
        status_, error = "sent", None
    except WhatsAppError as exc:
        mid, status_, error = None, "failed", str(exc)
    try:
        await wa_inbox.record_outbound(db, EnvelopeCrypto(db, svc.keys), org_id=snd.org_id, venture_id=venture_id,
                                       phone=phone, body=rendered, sent_by="person", status=status_, provider_id=mid,
                                       error=error, user_id=user_id, kind="template", name=name)
    except DBAPIError as exc:
        raise_for_db(exc, "chat not found")
    if error:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, error)
    return rendered


@router.post("/ventures/{venture_id}/whatsapp/chats/{chat_id}/template", response_model=MessageOut, status_code=201)
async def send_template(venture_id: uuid.UUID, chat_id: uuid.UUID, body: SendTemplateIn, user_id: UserId,
                        svc: Svc, db: TenantDB) -> MessageOut:
    """Sends an approved template in a chat, e.g. after the 24 hours have passed."""
    r = await _one(db, venture_id, chat_id)
    await _can_write(db, venture_id)
    await _plan_ok(db, venture_id)
    if r.opted_out_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "this customer asked not to receive messages (they wrote STOP)")
    await _send_template(db, svc, venture_id, user_id, phone=r.phone, name=None, body=body)
    m = (await wa_inbox.thread(db, EnvelopeCrypto(db, svc.keys), venture_id, chat_id, limit=1))[-1]
    return MessageOut(**m)


@router.post("/ventures/{venture_id}/whatsapp/chats", response_model=ChatOut, status_code=201)
async def new_chat(venture_id: uuid.UUID, body: NewChatIn, user_id: UserId, svc: Svc, db: TenantDB) -> ChatOut:
    """Writes first to someone who agreed to hear from the business, with an approved template.
    When they answer, Kritvia drafts the replies like in any other chat."""
    await venture_org(db, venture_id)
    await _can_write(db, venture_id)
    await _plan_ok(db, venture_id)
    phone = wa_inbox.digits(body.phone)
    if not body.phone.strip().startswith("+") and re.fullmatch(r"[6-9][0-9]{9}", phone):
        phone = "91" + phone                          # a 10-digit Indian mobile written without +91
    if not re.fullmatch(r"[1-9][0-9]{7,14}", phone):
        raise HTTPException(422, "write the number with its country code, e.g. +91 98111 22233")
    existing = await wa_inbox.find_contact(db, venture_id, phone)
    if existing is not None and existing.opted_out:
        raise HTTPException(status.HTTP_409_CONFLICT, "this customer asked not to receive messages (they wrote STOP)")
    await _send_template(db, svc, venture_id, user_id, phone=phone, name=body.name, body=body)
    cid = (await db.execute(text("SELECT id FROM wa_contacts WHERE venture_id = :v AND phone = :p"),
                            {"v": venture_id, "p": phone})).scalar_one()
    return await _chat(EnvelopeCrypto(db, svc.keys), venture_id, await _one(db, venture_id, cid))


# --- From the webhook ---------------------------------------------------------------------------
async def record_echo(conn, crypto: EnvelopeCrypto, *, org_id: uuid.UUID, venture_id: uuid.UUID,
                      to: str, body: str, kind: str, provider_id: str) -> list[uuid.UUID] | None:
    """A message the owner sent from the WhatsApp Business app on their phone. It goes in the chat, and
    the chat is the owner's now: Kritvia stops drafting there. Returns the chat's drafts still waiting
    for a yes (the caller withdraws them once this is saved), or None for a redelivered echo (or an
    echo of a message Kritvia sent itself)."""
    new = await wa_inbox.record_outbound(conn, crypto, org_id=org_id, venture_id=venture_id, phone=to, body=body,
                                         sent_by="phone", status="sent", provider_id=provider_id, kind=kind)
    if not new:
        return None
    contact = await wa_inbox.find_contact(conn, venture_id, to)
    if contact is None:
        return []
    if contact.handled_by == "kritvia":
        await wa_inbox.hand_to_person(conn, venture_id, contact.id, "Answered from the WhatsApp Business app")
    return await wa_inbox.waiting_runs(conn, venture_id, contact.id)


async def record_template_status(conn, venture_id: uuid.UUID, *, meta_id: str, name: str, language: str,
                                 status_: str, reason: str | None) -> str | None:
    """Meta finished reviewing a template (or paused it). Returns the template's name when it changed."""
    r = (await conn.execute(text(
        "UPDATE wa_templates SET status = :s, reason = :r, updated_at = now()"
        " WHERE venture_id = :v AND ((:id <> '' AND meta_id = :id) OR (name = :n AND language = :l))"
        "   AND status IS DISTINCT FROM :s RETURNING name"),
        {"v": venture_id, "id": meta_id, "n": name, "l": language, "s": status_, "r": reason})).scalar()
    return r


async def notify_template(venture_id: uuid.UUID, name: str, status_: str, reason: str | None) -> None:
    if status_ == "APPROVED":
        title, body = "Template approved", f"“{name}” can be sent on WhatsApp now"
    elif status_ in ("REJECTED", "PAUSED", "DISABLED"):
        title, body = f"Template {status_.lower()}", f"“{name}”: {reason or 'see the WhatsApp page'}"[:180]
    else:
        return
    await push.notify_venture(venture_id, title=title, body=body, url=f"/v/{venture_id}/whatsapp?tab=templates",
                              tag=f"wa-tpl-{name}")
