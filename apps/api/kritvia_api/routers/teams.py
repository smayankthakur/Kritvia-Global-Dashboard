"""Teams, and who works with whom.

  GET    /orgs/{org_id}/teams              the organisation's teams and people (anyone in it)
  POST   /orgs/{org_id}/teams              create a team (owners)
  PUT    /orgs/{org_id}/teams/{team_id}    rename, recolour, set members and leads (owners)
  DELETE /orgs/{org_id}/teams/{team_id}    delete a team; its boards stay, without a team (owners)
  GET    /ventures/{venture_id}/teams      the teams, for a business's pickers
  GET    /ventures/{venture_id}/collab     the mind map's People & projects view
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.deps import TenantDB, UserId, venture_org
from kritvia_api.errors import raise_for_db
from kritvia_api.services import collab

router = APIRouter(tags=["teams"])
Color = Literal["blue", "orange", "aqua", "yellow", "pink", "green", "violet", "red"]


class TeamPerson(BaseModel):
    user_id: uuid.UUID
    full_name: str
    email: str


class TeamMember(TeamPerson):
    is_lead: bool


class TeamOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    color: Color
    members: list[TeamMember]
    boards: int = Field(description="project boards that belong to the team, in every business")


class TeamsOut(BaseModel):
    teams: list[TeamOut]
    people: list[TeamPerson] = Field(description="everyone in the organisation, for the member picker")
    can_edit: bool


class TeamMemberIn(BaseModel):
    user_id: uuid.UUID
    is_lead: bool = False


class TeamIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    description: str | None = Field(default=None, max_length=280)
    color: Color = "blue"
    members: list[TeamMemberIn] = Field(default_factory=list, max_length=500)


class TeamBrief(BaseModel):
    id: uuid.UUID
    name: str
    color: Color


async def _member(db, org_id: uuid.UUID) -> bool:
    if not (await db.execute(text("SELECT :o = ANY (private.member_orgs())"), {"o": org_id})).scalar():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "organisation not found")
    return bool((await db.execute(text("SELECT :o = ANY (private.owned_orgs())"), {"o": org_id})).scalar())


async def _owner(db, org_id: uuid.UUID) -> None:
    if not await _member(db, org_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only the organisation's owners manage teams")


async def _teams(db, org_id: uuid.UUID) -> list[TeamOut]:
    people = {r.user_id: r for r in (await db.execute(text("SELECT * FROM org_people(:o)"), {"o": org_id})).all()}
    teams = (await db.execute(text(
        "SELECT t.id, t.name, t.description, t.color,"
        " (SELECT count(*) FROM task_boards b WHERE b.team_id = t.id) AS boards"
        " FROM teams t WHERE t.org_id = :o ORDER BY lower(t.name)"), {"o": org_id})).all()
    members = (await db.execute(text("SELECT team_id, user_id, is_lead FROM team_members WHERE org_id = :o"),
                                {"o": org_id})).all()
    by_team: dict[uuid.UUID, list[TeamMember]] = {}
    for m in members:
        p = people.get(m.user_id)
        if p:
            by_team.setdefault(m.team_id, []).append(
                TeamMember(user_id=p.user_id, full_name=p.full_name, email=p.email, is_lead=m.is_lead))
    out = []
    for t in teams:
        ms = sorted(by_team.get(t.id, []), key=lambda m: (not m.is_lead, m.full_name.lower()))
        out.append(TeamOut(id=t.id, name=t.name, description=t.description, color=t.color, members=ms, boards=t.boards))
    return out


async def _save_members(db, org_id: uuid.UUID, team_id: uuid.UUID, members: list[TeamMemberIn]) -> None:
    seen: dict[uuid.UUID, bool] = {}
    for m in members:
        seen[m.user_id] = seen.get(m.user_id, False) or m.is_lead
    await db.execute(text("DELETE FROM team_members WHERE team_id = :t AND NOT (user_id = ANY(:u))"),
                     {"t": team_id, "u": list(seen)})
    for uid, lead in seen.items():
        await db.execute(text(
            "INSERT INTO team_members (org_id, team_id, user_id, is_lead) VALUES (:o, :t, :u, :l)"
            " ON CONFLICT (team_id, user_id) DO UPDATE SET is_lead = EXCLUDED.is_lead"
            " WHERE team_members.is_lead IS DISTINCT FROM EXCLUDED.is_lead"),
            {"o": org_id, "t": team_id, "u": uid, "l": lead})


def _clean(body: TeamIn) -> tuple[str, str | None]:
    name = " ".join(body.name.split())
    if not name:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "give the team a name")
    return name, (body.description or "").strip() or None


@router.get("/orgs/{org_id}/teams", response_model=TeamsOut)
async def list_teams(org_id: uuid.UUID, db: TenantDB) -> TeamsOut:
    can_edit = await _member(db, org_id)
    people = (await db.execute(text("SELECT * FROM org_people(:o)"), {"o": org_id})).all()
    return TeamsOut(teams=await _teams(db, org_id), can_edit=can_edit,
                    people=[TeamPerson(**r._mapping) for r in people])


@router.post("/orgs/{org_id}/teams", response_model=TeamOut, status_code=201)
async def create_team(org_id: uuid.UUID, body: TeamIn, db: TenantDB, user_id: UserId) -> TeamOut:
    await _owner(db, org_id)
    name, desc = _clean(body)
    try:
        async with db.begin_nested():
            tid = (await db.execute(text(
                "INSERT INTO teams (org_id, name, description, color, created_by) VALUES (:o, :n, :d, :c, :u) RETURNING id"),
                {"o": org_id, "n": name, "d": desc, "c": body.color, "u": user_id})).scalar_one()
            await _save_members(db, org_id, tid, body.members)
    except DBAPIError as exc:
        if "teams_name_uq" in str(exc):
            raise HTTPException(status.HTTP_409_CONFLICT, f"there is already a team called “{name}”") from None
        raise_for_db(exc, "organisation not found")
    return next(t for t in await _teams(db, org_id) if t.id == tid)


@router.put("/orgs/{org_id}/teams/{team_id}", response_model=TeamOut)
async def update_team(org_id: uuid.UUID, team_id: uuid.UUID, body: TeamIn, db: TenantDB) -> TeamOut:
    await _owner(db, org_id)
    name, desc = _clean(body)
    try:
        async with db.begin_nested():
            found = (await db.execute(text(
                "UPDATE teams SET name = :n, description = :d, color = :c, updated_at = now()"
                " WHERE org_id = :o AND id = :t RETURNING id"),
                {"o": org_id, "t": team_id, "n": name, "d": desc, "c": body.color})).first()
            if found is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "team not found")
            await _save_members(db, org_id, team_id, body.members)
    except DBAPIError as exc:
        if "teams_name_uq" in str(exc):
            raise HTTPException(status.HTTP_409_CONFLICT, f"there is already a team called “{name}”") from None
        raise_for_db(exc, "team not found")
    return next(t for t in await _teams(db, org_id) if t.id == team_id)


@router.delete("/orgs/{org_id}/teams/{team_id}", status_code=204)
async def delete_team(org_id: uuid.UUID, team_id: uuid.UUID, db: TenantDB) -> None:
    await _owner(db, org_id)
    res = await db.execute(text("DELETE FROM teams WHERE org_id = :o AND id = :t"), {"o": org_id, "t": team_id})
    if res.rowcount == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "team not found")


@router.get("/ventures/{venture_id}/teams", response_model=list[TeamBrief])
async def venture_teams(venture_id: uuid.UUID, db: TenantDB) -> list[TeamBrief]:
    org = await venture_org(db, venture_id)
    rows = (await db.execute(text("SELECT id, name, color FROM teams WHERE org_id = :o ORDER BY lower(name)"),
                             {"o": org})).all()
    return [TeamBrief(**r._mapping) for r in rows]


# ------------------------------------------------------------- who works with whom --
class CollabDoc(BaseModel):
    id: uuid.UUID
    title: str
    kind: str
    date: datetime | None


class CollabPerson(BaseModel):
    id: str = Field(description="a user id, or c:<name> for an outside contact named in documents")
    kind: Literal["member", "contact"]
    name: str
    email: str | None
    teams: list[str]
    leads: list[str] = Field(description="teams this person leads")
    open_tasks: int
    done_tasks: int
    documents: int = Field(description="meetings, emails and documents naming them in the period")
    outside: bool = Field(description="team view: works with the team but isn't in it")
    strength: float


class CollabProject(BaseModel):
    id: str = Field(description="p:<board id>")
    board_id: uuid.UUID
    name: str
    team_id: uuid.UUID | None
    people: int
    open_tasks: int


class CollabTeam(BaseModel):
    id: str = Field(description="t:<team id>")
    team_id: uuid.UUID
    name: str
    color: Color
    members: int


class CollabLink(BaseModel):
    source: str
    target: str
    kind: Literal["works_with", "on_project", "in_team", "project_team"]
    strength: float
    shared_tasks: int = Field(description="works_with: tasks on shared project boards; on_project: their tasks there")
    handoffs: int = Field(description="tasks one made and gave to the other")
    meetings: int
    emails: int
    other_docs: int
    mentions: int = Field(description="on_project: documents naming them with the project")
    same_team: bool
    is_lead: bool
    teams: list[str]
    projects: list[str]
    evidence: list[CollabDoc] = Field(description="the latest meetings, emails and documents naming both")


class CollabOut(BaseModel):
    people: list[CollabPerson]
    projects: list[CollabProject]
    teams: list[CollabTeam]
    links: list[CollabLink]
    boards: list[TeamBrief] = Field(description="the business's project boards, for the filter (colour unused)")
    days: int
    truncated: bool


@router.get("/ventures/{venture_id}/collab", response_model=CollabOut)
async def collaboration(
    venture_id: uuid.UUID, db: TenantDB,
    project: uuid.UUID | None = Query(default=None, description="a project board"),
    team: uuid.UUID | None = None,
    days: int = Query(default=90, ge=7, le=730),
    tasks: bool = True, docs: bool = True, teams: bool = True, contacts: bool = True,
) -> CollabOut:
    """Who works with whom in this business, on a project or in a team. Everything comes from what the
    caller can already see: task cards, the knowledge graph and documents are read under their access."""
    org = await venture_org(db, venture_id)
    since = datetime.now(UTC) - timedelta(days=days)
    people = {str(r.user_id): {"full_name": r.full_name, "email": r.email}
              for r in (await db.execute(text("SELECT * FROM venture_people(:v)"), {"v": venture_id})).all()}
    team_rows = (await db.execute(text("SELECT id, name, color FROM teams WHERE org_id = :o"), {"o": org})).all()
    members = (await db.execute(text("SELECT team_id, user_id, is_lead FROM team_members WHERE org_id = :o"),
                                {"o": org})).all()
    boards = (await db.execute(text("SELECT id, name, is_default, team_id FROM task_boards WHERE venture_id = :v"),
                               {"v": venture_id})).all()
    cards = (await db.execute(text(
        "SELECT board_id, assignee_id, created_by,"
        " count(*) FILTER (WHERE done_at IS NULL AND archived_at IS NULL) AS open,"
        " count(*) FILTER (WHERE done_at IS NOT NULL) AS done"
        " FROM task_cards WHERE venture_id = :v AND (assignee_id IS NOT NULL OR created_by IS NOT NULL)"
        " AND (archived_at IS NULL OR archived_at >= :s)"
        " AND ((done_at IS NULL AND archived_at IS NULL) OR done_at >= :s OR updated_at >= :s)"
        " GROUP BY board_id, assignee_id, created_by"), {"v": venture_id, "s": since})).all()
    mentions: list = []
    if docs:
        mentions = list((await db.execute(text(
            "WITH d AS (SELECT id, title, kind, created_at FROM documents WHERE venture_id = :v AND created_at >= :s"
            "             ORDER BY created_at DESC LIMIT 500),"
            " m AS (SELECT x.src_id AS entity_id, ch.document_id FROM edges x JOIN chunks ch ON ch.id = x.source_chunk_id"
            "        WHERE x.venture_id = :v AND ch.document_id IN (SELECT id FROM d)"
            "       UNION SELECT x.dst_id, ch.document_id FROM edges x JOIN chunks ch ON ch.id = x.source_chunk_id"
            "        WHERE x.venture_id = :v AND ch.document_id IN (SELECT id FROM d)"
            "       UNION SELECT f.subject_id, ch.document_id FROM facts f JOIN chunks ch ON ch.id = f.source_chunk_id"
            "        WHERE f.venture_id = :v AND f.subject_id IS NOT NULL AND ch.document_id IN (SELECT id FROM d))"
            " SELECT d.id AS document_id, d.title, d.kind, d.created_at, e.type, e.name, e.attrs->>'email' AS email"
            "   FROM m JOIN entities e ON e.id = m.entity_id AND e.type IN ('person', 'project') JOIN d ON d.id = m.document_id"
            " UNION"
            " SELECT d.id, d.title, d.kind, d.created_at, 'person', f.owner, NULL"
            "   FROM facts f JOIN chunks ch ON ch.id = f.source_chunk_id JOIN d ON d.id = ch.document_id"
            "  WHERE f.venture_id = :v AND f.owner IS NOT NULL AND btrim(f.owner) <> ''"),
            {"v": venture_id, "s": since})).all())
    out = collab.build(
        people=people, teams=[r._mapping for r in team_rows], members=[r._mapping for r in members],
        boards=[r._mapping for r in boards], cards=[r._mapping for r in cards], mentions=[r._mapping for r in mentions],
        project=str(project) if project else None, team=str(team) if team else None,
        use_tasks=tasks, use_docs=docs, use_teams=teams, contacts=contacts)
    board_list = [TeamBrief(id=b.id, name=b.name, color="blue")
                  for b in sorted(boards, key=lambda b: (b.is_default, b.name.lower())) if not b.is_default]
    return CollabOut(**out, boards=board_list, days=days)
