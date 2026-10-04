import uuid
from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.deps import Svc, TenantDB
from kritvia_api.plans import PLANS, PUBLIC_PLANS, TOKEN_PACKS
from kritvia_api.services.quota import org_usage, require_room
from kritvia_api.errors import raise_for_db
from kritvia_api.schemas import GrantIn, IdOut, MemberIn, OrgIn, VentureIn, VentureOut

router = APIRouter(prefix="/orgs", tags=["organisations"])


async def _user_id_by_email(db, org_id: uuid.UUID, email: str) -> uuid.UUID:
    """Resolves only yourself or people already in the org, and only for its owner.
    The same 404 for every other case, so registered emails can't be enumerated."""
    uid = (await db.execute(text("SELECT org_member_by_email(:o, :e)"), {"o": org_id, "e": email})).scalar()
    if uid is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            "organisation not found, or this person is not in it yet — send an invitation")
    return uid


@router.post("", response_model=IdOut, status_code=201)
async def create_org(body: OrgIn, db: TenantDB) -> IdOut:
    try:
        async with db.begin_nested():
            oid = (await db.execute(text("SELECT create_organisation(:n, :s)"),
                                    {"n": body.name, "s": body.slug})).scalar_one()
    except DBAPIError as exc:
        raise_for_db(exc)
    return IdOut(id=oid)


@router.get("", response_model=list[IdOut])
async def list_orgs(db: TenantDB) -> list[IdOut]:
    rows = (await db.execute(text("SELECT id FROM organisations ORDER BY created_at"))).all()
    return [IdOut(id=r.id) for r in rows]


@router.post("/{org_id}/ventures", response_model=IdOut, status_code=201)
async def create_venture(org_id: uuid.UUID, body: VentureIn, db: TenantDB, svc: Svc) -> IdOut:
    await require_room(db, org_id, "venture", svc.router.local_deployments())
    try:
        async with db.begin_nested():
            vid = (await db.execute(text("SELECT create_venture(:o, :n, :s)"),
                                    {"o": org_id, "n": body.name.strip(), "s": body.slug})).scalar_one()
            if body.kind:
                await db.execute(text(
                    "INSERT INTO venture_settings (org_id, venture_id, kind, business_name) VALUES (:o, :v, :k, :n)"
                    " ON CONFLICT (venture_id) DO UPDATE SET kind = EXCLUDED.kind"),
                    {"o": org_id, "v": vid, "k": body.kind, "n": body.name.strip()})
    except DBAPIError as exc:
        raise_for_db(exc, "organisation not found")
    return IdOut(id=vid)


@router.get("/{org_id}/ventures", response_model=list[VentureOut])
async def list_ventures(org_id: uuid.UUID, db: TenantDB) -> list[VentureOut]:
    rows = (await db.execute(text(
        "SELECT v.id, v.org_id, v.name, v.slug, coalesce(s.kind, 'general') AS kind FROM ventures v"
        " LEFT JOIN venture_settings s ON s.venture_id = v.id"
        " WHERE v.org_id = :o AND v.removed_at IS NULL ORDER BY v.name"), {"o": org_id})).all()
    return [VentureOut.model_validate(r) for r in rows]


# --- Renaming, removing and restoring a business ------------------------------------------------
RESTORE_DAYS = 30


class RenameIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class RemoveIn(BaseModel):
    confirm: str = Field(max_length=120, description="the business name, typed again")


class RemovedVentureOut(BaseModel):
    id: uuid.UUID
    name: str
    kind: str
    removed_at: datetime
    erase_after: datetime


async def _venture_in_org(db, org_id: uuid.UUID, venture_id: uuid.UUID) -> None:
    found = (await db.execute(text("SELECT 1 FROM ventures WHERE id = :v AND org_id = :o"),
                              {"v": venture_id, "o": org_id})).first()
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "business not found")


@router.patch("/{org_id}/ventures/{venture_id}", response_model=VentureOut)
async def rename_venture(org_id: uuid.UUID, venture_id: uuid.UUID, body: RenameIn, db: TenantDB) -> VentureOut:
    """Owners and business admins can rename a business."""
    await _venture_in_org(db, org_id, venture_id)
    try:
        async with db.begin_nested():
            await db.execute(text("SELECT rename_venture(:v, :n)"), {"v": venture_id, "n": body.name})
    except DBAPIError as exc:
        raise_for_db(exc, "business not found")
    rows = [v for v in await list_ventures(org_id, db) if v.id == venture_id]
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "business not found")
    return rows[0]


@router.post("/{org_id}/ventures/{venture_id}/remove", status_code=204)
async def remove_venture(org_id: uuid.UUID, venture_id: uuid.UUID, body: RemoveIn, db: TenantDB, svc: Svc) -> None:
    """Owner only. Stops the business's agents and connectors and hides its data at once; it can be
    restored for 30 days, after which its data is erased."""
    await _venture_in_org(db, org_id, venture_id)
    try:
        async with db.begin_nested():
            await db.execute(text("SELECT remove_venture(:v, :c)"), {"v": venture_id, "c": body.confirm})
    except DBAPIError as exc:
        raise_for_db(exc, "business not found")
    svc.router.forget_routes()


@router.get("/{org_id}/ventures/removed", response_model=list[RemovedVentureOut])
async def removed_ventures(org_id: uuid.UUID, db: TenantDB) -> list[RemovedVentureOut]:
    rows = (await db.execute(text("SELECT * FROM removed_ventures(:o)"), {"o": org_id})).all()
    return [RemovedVentureOut(id=r.id, name=r.name, kind=r.kind, removed_at=r.removed_at,
                              erase_after=r.removed_at + timedelta(days=RESTORE_DAYS)) for r in rows]


@router.post("/{org_id}/ventures/{venture_id}/restore", response_model=IdOut)
async def restore_venture(org_id: uuid.UUID, venture_id: uuid.UUID, db: TenantDB, svc: Svc) -> IdOut:
    """Owner only, within 30 days. Agents stay off and connectors must be reconnected."""
    await _venture_in_org(db, org_id, venture_id)
    await require_room(db, org_id, "venture", svc.router.local_deployments())
    try:
        async with db.begin_nested():
            await db.execute(text("SELECT restore_venture(:v)"), {"v": venture_id})
    except DBAPIError as exc:
        raise_for_db(exc, "business not found")
    return IdOut(id=venture_id)


@router.post("/{org_id}/members", response_model=IdOut, status_code=201)
async def add_member(org_id: uuid.UUID, body: MemberIn, db: TenantDB) -> IdOut:
    uid = await _user_id_by_email(db, org_id, body.user_email)
    try:
        async with db.begin_nested():
            mid = (await db.execute(text("SELECT add_member(:o, :v, :u, :r)"),
                                    {"o": org_id, "v": body.venture_id, "u": uid, "r": body.role})).scalar_one()
    except DBAPIError as exc:
        raise_for_db(exc, "organisation not found")
    return IdOut(id=mid)


@router.post("/{org_id}/grants", response_model=IdOut, status_code=201)
async def grant(org_id: uuid.UUID, body: GrantIn, db: TenantDB) -> IdOut:
    uid = await _user_id_by_email(db, org_id, body.user_email)
    try:
        async with db.begin_nested():
            gid = (await db.execute(
                text("SELECT grant_access(:o, :v, :u, :a, :r, :x)"),
                {"o": org_id, "v": body.venture_id, "u": uid, "a": body.access,
                 "r": body.reason, "x": body.expires_at},
            )).scalar_one()
    except DBAPIError as exc:
        raise_for_db(exc, "organisation not found")
    return IdOut(id=gid)


@router.delete("/{org_id}/grants/{grant_id}", status_code=204)
async def revoke(org_id: uuid.UUID, grant_id: uuid.UUID, db: TenantDB) -> None:
    try:
        async with db.begin_nested():
            await db.execute(text("SELECT revoke_access(:g)"), {"g": grant_id})
    except DBAPIError as exc:
        raise_for_db(exc, "grant not found")


@router.get("/{org_id}/plan", response_model=dict)
async def get_plan(org_id: uuid.UUID, db: TenantDB, svc: Svc) -> dict:
    """The organisation's plan, its limits and this month's usage."""
    u = await org_usage(db, org_id, svc.router.local_deployments())
    if u is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "organisation not found")
    renews = (await db.execute(text("SELECT renews_at FROM org_plans WHERE org_id = :o"), {"o": org_id})).scalar()
    return {**u.as_dict(), "renews_at": renews.isoformat() if renews else None,
            "available": [PLANS[c].as_dict() for c in PUBLIC_PLANS], "token_packs": list(TOKEN_PACKS)}
