import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import text

from kritvia_api.deps import TenantDB
from kritvia_api.schemas import AuditOut, AuditVerifyOut

router = APIRouter(prefix="/orgs/{org_id}/audit", tags=["audit"])


@router.get("", response_model=list[AuditOut])
async def list_audit(org_id: uuid.UUID, db: TenantDB, venture_id: uuid.UUID | None = None,
                     limit: int = 100) -> list[AuditOut]:
    q = ("SELECT seq, occurred_at, venture_id, actor_type, actor_user_id, action, entity_table,"
         " entity_id, details FROM audit_log WHERE org_id = :o")
    params: dict = {"o": org_id, "l": min(max(limit, 1), 500)}
    if venture_id:
        q += " AND venture_id = :v"
        params["v"] = venture_id
    rows = (await db.execute(text(q + " ORDER BY seq DESC LIMIT :l"), params)).all()
    return [AuditOut.model_validate(r._asdict()) for r in rows]


@router.get("/verify", response_model=AuditVerifyOut)
async def verify(org_id: uuid.UUID, db: TenantDB) -> AuditVerifyOut:
    owner = (await db.execute(text("SELECT :o = ANY (private.owned_orgs())"), {"o": org_id})).scalar_one()
    if not owner:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "organisation not found")
    broken = (await db.execute(text("SELECT private.audit_verify(:o)"), {"o": org_id})).scalar_one()
    return AuditVerifyOut(org_id=org_id, intact=broken is None, first_broken_seq=broken)
