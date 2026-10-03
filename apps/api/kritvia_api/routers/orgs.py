import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.deps import Svc, TenantDB
from kritvia_api.plans import PLANS, PUBLIC_PLANS
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
                                    {"o": org_id, "n": body.name, "s": body.slug})).scalar_one()
    except DBAPIError as exc:
        raise_for_db(exc, "organisation not found")
    return IdOut(id=vid)


@router.get("/{org_id}/ventures", response_model=list[VentureOut])
async def list_ventures(org_id: uuid.UUID, db: TenantDB) -> list[VentureOut]:
    rows = (await db.execute(
        text("SELECT id, org_id, name, slug FROM ventures WHERE org_id = :o ORDER BY name"), {"o": org_id}
    )).all()
    return [VentureOut.model_validate(r) for r in rows]


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
            "available": [PLANS[c].as_dict() for c in PUBLIC_PLANS]}
