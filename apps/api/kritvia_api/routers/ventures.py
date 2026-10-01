"""Caller's access map, venture settings, members."""
from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.config import get_settings
from kritvia_api.deps import TenantDB, venture_org
from kritvia_api.errors import raise_for_db

router = APIRouter(tags=["ventures"])

VentureKind = Literal["general", "software", "finance", "kitchen"]


class AccessOut(BaseModel):
    org_id: uuid.UUID
    org_name: str
    venture_id: uuid.UUID
    venture_name: str
    venture_slug: str
    kind: str
    roles: list[str]
    access: Literal["read", "write"]
    is_owner: bool
    can_admin: bool


class OrgSummary(BaseModel):
    id: uuid.UUID
    name: str
    slug: str
    is_owner: bool


class MeAccessOut(BaseModel):
    orgs: list[OrgSummary]
    ventures: list[AccessOut]


@router.get("/me/access", response_model=MeAccessOut)
async def my_access(db: TenantDB) -> MeAccessOut:
    orgs = (await db.execute(text(
        "SELECT o.id, o.name, o.slug, o.id = ANY (private.owned_orgs()) AS is_owner FROM organisations o"
        " ORDER BY o.created_at"))).all()
    rows = (await db.execute(text(
        "SELECT a.*, a.org_id = ANY (private.owned_orgs()) AS is_owner,"
        " private.can_admin_venture(a.venture_id) AS can_admin FROM my_access() a"))).all()
    return MeAccessOut(orgs=[OrgSummary(**r._mapping) for r in orgs],
                       ventures=[AccessOut(**r._mapping) for r in rows])


class VentureSettingsIn(BaseModel):
    kind: VentureKind | None = None
    trust_threshold: int | None = Field(default=None, ge=5, le=1000)
    timezone: str | None = Field(default=None, max_length=60)
    speech_people_hints: bool | None = None


class VentureSettingsOut(BaseModel):
    venture_id: uuid.UUID
    kind: str
    trust_threshold: int
    timezone: str
    speech_people_hints: bool = Field(
        default=False, description="Send people's names from the knowledge graph to hosted speech models as "
                                   "spelling hints (local models always get them)")


async def _require_admin(db, venture_id: uuid.UUID) -> None:
    ok = (await db.execute(text("SELECT private.can_admin_venture(:v)"), {"v": venture_id})).scalar()
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "venture not found")


@router.get("/ventures/{venture_id}/settings", response_model=VentureSettingsOut)
async def get_settings_(venture_id: uuid.UUID, db: TenantDB) -> VentureSettingsOut:
    await venture_org(db, venture_id)
    row = (await db.execute(text(
        "SELECT coalesce(kind, 'general') AS kind, coalesce(trust_threshold, 30) AS trust_threshold,"
        " coalesce(timezone, 'Asia/Kolkata') AS timezone,"
        " coalesce(speech_people_hints, false) AS speech_people_hints FROM (SELECT 1) x"
        " LEFT JOIN venture_settings s ON s.venture_id = :v"), {"v": venture_id})).first()
    return VentureSettingsOut(venture_id=venture_id, **row._mapping)


@router.put("/ventures/{venture_id}/settings", response_model=VentureSettingsOut)
async def put_settings(venture_id: uuid.UUID, body: VentureSettingsIn, db: TenantDB) -> VentureSettingsOut:
    org = await venture_org(db, venture_id)
    await _require_admin(db, venture_id)
    try:
        async with db.begin_nested():
            await db.execute(text(
                "INSERT INTO venture_settings (org_id, venture_id, kind, trust_threshold, timezone,"
                " speech_people_hints) VALUES (:o, :v, coalesce(:k, 'general'), coalesce(:t, 30),"
                " coalesce(:tz, 'Asia/Kolkata'), coalesce(:ph, false))"
                " ON CONFLICT (venture_id) DO UPDATE SET kind = coalesce(:k, venture_settings.kind),"
                " trust_threshold = coalesce(:t, venture_settings.trust_threshold),"
                " timezone = coalesce(:tz, venture_settings.timezone),"
                " speech_people_hints = coalesce(:ph, venture_settings.speech_people_hints), updated_at = now()"),
                {"o": org, "v": venture_id, "k": body.kind, "t": body.trust_threshold, "tz": body.timezone,
                 "ph": body.speech_people_hints})
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    return await get_settings_(venture_id, db)


class MemberOut(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    email: str
    full_name: str
    role: str
    venture_id: uuid.UUID | None
    is_service: bool


@router.get("/orgs/{org_id}/members", response_model=list[MemberOut])
async def list_members(org_id: uuid.UUID, db: TenantDB) -> list[MemberOut]:
    rows = (await db.execute(text(
        "SELECT m.id, m.user_id, u.email, u.full_name, m.role, m.venture_id, u.is_service"
        " FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = :o"
        " ORDER BY u.is_service, u.email, m.role"), {"o": org_id})).all()
    return [MemberOut(**r._mapping) for r in rows]


@router.delete("/orgs/{org_id}/members/{membership_id}", status_code=204)
async def remove_member(org_id: uuid.UUID, membership_id: uuid.UUID, db: TenantDB) -> None:
    try:
        async with db.begin_nested():
            await db.execute(text("SELECT remove_member(:m)"), {"m": membership_id})
    except DBAPIError as exc:
        raise_for_db(exc, "membership not found")


class GrantOut(BaseModel):
    id: uuid.UUID
    venture_id: uuid.UUID
    grantee_user_id: uuid.UUID
    email: str
    access: str
    reason: str
    expires_at: str | None


@router.get("/orgs/{org_id}/grants", response_model=list[GrantOut])
async def list_grants(org_id: uuid.UUID, db: TenantDB) -> list[GrantOut]:
    rows = (await db.execute(text(
        "SELECT g.id, g.venture_id, g.grantee_user_id, u.email, g.access, g.reason,"
        " to_char(g.expires_at, 'YYYY-MM-DD\"T\"HH24:MI:SSOF') AS expires_at"
        " FROM grants g JOIN users u ON u.id = g.grantee_user_id WHERE g.org_id = :o ORDER BY g.created_at"),
        {"o": org_id})).all()
    return [GrantOut(**r._mapping) for r in rows]


# ---------------------------------------------------------------- invitations --
class InvitationIn(BaseModel):
    email: str = Field(min_length=3, max_length=254, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    role: Literal["venture_admin", "operator", "approver", "viewer", "kitchen_manager", "loan_officer"]
    venture_id: uuid.UUID
    days: int = Field(default=7, ge=1, le=30)


class InvitationCreatedOut(BaseModel):
    id: uuid.UUID
    url: str
    token: str = Field(description="shown once — send it to the invitee yourself")
    expires_at: datetime


class InvitationOut(BaseModel):
    id: uuid.UUID
    email: str
    role: str
    venture_id: uuid.UUID | None
    expires_at: datetime
    accepted_at: datetime | None
    revoked_at: datetime | None
    created_at: datetime


@router.post("/orgs/{org_id}/invitations", response_model=InvitationCreatedOut, status_code=201)
async def invite(org_id: uuid.UUID, body: InvitationIn, db: TenantDB) -> InvitationCreatedOut:
    token = secrets.token_urlsafe(32)
    try:
        async with db.begin_nested():
            iid = (await db.execute(text("SELECT create_invitation(:o, :v, :e, :r, :h, :d)"),
                                    {"o": org_id, "v": body.venture_id, "e": body.email, "r": body.role,
                                     "h": hashlib.sha256(token.encode()).hexdigest(), "d": body.days})).scalar_one()
    except DBAPIError as exc:
        raise_for_db(exc, "organisation not found")
    row = (await db.execute(text("SELECT expires_at FROM invitations WHERE id = :id"), {"id": iid})).first()
    return InvitationCreatedOut(id=iid, url=f"{get_settings().public_web_url}/invite/{token}", token=token,
                                expires_at=row.expires_at)


@router.get("/orgs/{org_id}/invitations", response_model=list[InvitationOut])
async def list_invitations(org_id: uuid.UUID, db: TenantDB) -> list[InvitationOut]:
    rows = (await db.execute(text(
        "SELECT id, email, role, venture_id, expires_at, accepted_at, revoked_at, created_at FROM invitations"
        " WHERE org_id = :o ORDER BY created_at DESC LIMIT 200"), {"o": org_id})).all()
    return [InvitationOut(**r._mapping) for r in rows]


@router.delete("/orgs/{org_id}/invitations/{invitation_id}", status_code=204)
async def revoke_invitation(org_id: uuid.UUID, invitation_id: uuid.UUID, db: TenantDB) -> None:
    try:
        async with db.begin_nested():
            await db.execute(text("SELECT revoke_invitation(:i)"), {"i": invitation_id})
    except DBAPIError as exc:
        raise_for_db(exc, "invitation not found")


class AcceptIn(BaseModel):
    token: str = Field(min_length=20, max_length=100)


class AcceptedOut(BaseModel):
    org_id: uuid.UUID
    venture_id: uuid.UUID | None
    role: str


@router.post("/invitations/accept", response_model=AcceptedOut)
async def accept_invitation(body: AcceptIn, db: TenantDB) -> AcceptedOut:
    try:
        async with db.begin_nested():
            row = (await db.execute(text("SELECT * FROM accept_invitation(:h)"),
                                    {"h": hashlib.sha256(body.token.encode()).hexdigest()})).first()
    except DBAPIError as exc:
        raise_for_db(exc, "invitation not found or expired")
    return AcceptedOut(**row._mapping)
