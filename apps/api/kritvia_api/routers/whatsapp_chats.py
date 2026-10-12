"""The WhatsApp page: a business's customer chats, read and answered by its team.

Kritvia drafts replies for every chat it handles (inbox assistant). A person can take a chat over
at any time, and does so automatically by replying here; Kritvia then stays quiet in that chat
until someone gives it back. Messages can only be sent within WhatsApp's 24-hour window.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.db.session import tenant_tx
from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.errors import raise_for_db
from kritvia_api.services import wa_inbox
from kritvia_api.services.crypto import EnvelopeCrypto
from kritvia_api.services.quota import PlanRestricted, require_integration
from kritvia_api.services.whatsapp import WhatsAppConn, WhatsAppError

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
    sent_by: Literal["customer", "kritvia", "person"]
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
                db: TenantDB) -> MessageOut:
    """A person answers the customer now. Kritvia steps back from this chat until it is given back."""
    r = await _one(db, venture_id, chat_id)
    await _can_write(db, venture_id)
    try:
        await require_integration(db, venture_id, "whatsapp")
    except PlanRestricted as exc:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, str(exc)) from None
    if r.opted_out_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "this customer asked not to receive messages (they wrote STOP)")
    if not wa_inbox.window_open(r.last_inbound_at):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "the customer last wrote more than 24 hours ago; WhatsApp only allows a reply after "
                            "they write again")
    c = (await db.execute(text(
        "SELECT external_id FROM connectors WHERE venture_id = :v AND provider = 'whatsapp' AND status = 'active'"),
        {"v": venture_id})).first()
    if c is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "connect WhatsApp in Settings → Connectors first")
    # The token is readable only by the agent runtime and admins; the send runs as the runtime.
    p = (await db.execute(text("SELECT * FROM private.whatsapp_principal(:p)"), {"p": c.external_id})).first()
    if p is None or p.venture_id != venture_id:
        raise HTTPException(status.HTTP_409_CONFLICT, "connect WhatsApp in Settings → Connectors first")
    async with tenant_tx(p.run_as, "agent", "whatsapp") as rconn:
        tok = (await rconn.execute(text("SELECT secret_enc FROM connector_tokens WHERE connector_id = :c"),
                                   {"c": p.connector_id})).scalar()
        token = await EnvelopeCrypto(rconn, svc.keys).decrypt_str(venture_id, "connector.secret", tok) if tok else None
    if not token:
        raise HTTPException(status.HTTP_409_CONFLICT, "reconnect WhatsApp in Settings → Connectors")
    text_ = body.body.strip()
    crypto = EnvelopeCrypto(db, svc.keys)
    try:
        mid = await svc.whatsapp.send_text(WhatsAppConn(p.connector_id, c.external_id, None, token),
                                           to=r.phone, body=text_)
        status_, error = "sent", None
    except WhatsAppError as exc:
        mid, status_, error = None, "failed", str(exc)
    try:
        await wa_inbox.record_outbound(db, crypto, org_id=p.org_id, venture_id=venture_id, phone=r.phone,
                                       body=text_, sent_by="person", status=status_, provider_id=mid, error=error,
                                       user_id=user_id)
        if r.handled_by == "kritvia":
            await wa_inbox.hand_to_person(db, venture_id, chat_id, "A person replied")
    except DBAPIError as exc:
        raise_for_db(exc, "chat not found")
    if error:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, error)
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
