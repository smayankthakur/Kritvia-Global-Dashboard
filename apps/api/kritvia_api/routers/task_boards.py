"""Task boards (Trello-style): boards → lists → cards per business.

Card titles, descriptions and checklists are encrypted with the business's key. Cards made
from extracted tasks show the task's statement (and link to where it was said) until renamed.
Everyone who can see the business can read its boards; people with write access change them.
"""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from kritvia_api.deps import Svc, TenantDB, UserId, venture_org
from kritvia_api.errors import raise_for_db
from kritvia_api.services import memory
from kritvia_api.services.crypto import EnvelopeCrypto

router = APIRouter(tags=["tasks"])

TITLE = "task_cards.title"
DESC = "task_cards.description"
CHECK = "task_cards.checklist"
TaskLabelColor = Literal["green", "yellow", "orange", "red", "purple", "blue", "sky", "gray"]
STEP = 1024.0


# ------------------------------------------------------------------ models --
class TaskLabel(BaseModel):
    name: str = Field(default="", max_length=24)
    color: TaskLabelColor


class TaskCheckItem(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    text: str = Field(min_length=1, max_length=200)
    done: bool = False


class VenturePerson(BaseModel):
    user_id: uuid.UUID
    full_name: str
    email: str


class TaskCardSource(BaseModel):
    document_id: uuid.UUID
    document_title: str
    chunk_id: uuid.UUID
    source_start_s: float | None
    owner: str | None


class TaskCardOut(BaseModel):
    id: uuid.UUID
    board_id: uuid.UUID
    list_id: uuid.UUID
    title: str
    description: str
    checklist: list[TaskCheckItem]
    labels: list[TaskLabel]
    position: float
    assignee: VenturePerson | None
    due_date: date | None
    done_at: datetime | None
    archived: bool
    source: TaskCardSource | None
    created_at: datetime
    updated_at: datetime


class TaskListOut(BaseModel):
    id: uuid.UUID
    name: str
    position: float
    is_done: bool
    cards: list[TaskCardOut]


class TaskBoardOut(BaseModel):
    id: uuid.UUID
    name: str
    position: float
    is_default: bool
    cards: int = 0


class TaskBoardDetail(TaskBoardOut):
    lists: list[TaskListOut]
    can_edit: bool


class TaskBoardIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class TaskBoardPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    position: float | None = None


class TaskListIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    position: float | None = None


class TaskListPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    position: float | None = None
    is_done: bool | None = None


class TaskCardIn(BaseModel):
    list_id: uuid.UUID
    title: str = Field(min_length=1, max_length=500)
    position: float | None = None


class TaskCardPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=500)
    description: str | None = Field(default=None, max_length=10_000)
    assignee_id: uuid.UUID | None = None
    clear_assignee: bool = False
    due_date: date | None = None
    clear_due_date: bool = False
    labels: list[TaskLabel] | None = Field(default=None, max_length=10)
    checklist: list[TaskCheckItem] | None = Field(default=None, max_length=50)
    archived: bool | None = None

    @field_validator("title", "description")
    @classmethod
    def _strip(cls, v: str | None) -> str | None:
        return v.strip() if v is not None else v


class TaskCardMove(BaseModel):
    list_id: uuid.UUID
    position: float | None = None   # None = to the bottom of the list


# ----------------------------------------------------------------- helpers --
async def _can_write(db, venture_id: uuid.UUID) -> bool:
    return bool((await db.execute(text("SELECT :v = ANY (private.writable_ventures())"), {"v": venture_id})).scalar())


async def _require_write(db, venture_id: uuid.UUID) -> uuid.UUID:
    org = await venture_org(db, venture_id)
    if not await _can_write(db, venture_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "venture not found")
    return org


async def _bottom(db, list_id: uuid.UUID) -> float:
    return float((await db.execute(text(
        "SELECT coalesce(max(position), 0) + :s FROM task_cards WHERE list_id = :l AND archived_at IS NULL"),
        {"l": list_id, "s": STEP})).scalar())


async def _renumber_if_crowded(db, list_id: uuid.UUID) -> None:
    """Positions are midpoints between neighbours; space them out again before they collide."""
    gap = (await db.execute(text(
        "SELECT min(d) FROM (SELECT position - lag(position) OVER (ORDER BY position) AS d FROM task_cards"
        " WHERE list_id = :l AND archived_at IS NULL) x"), {"l": list_id})).scalar()
    if gap is not None and gap < 1e-6:
        await db.execute(text(
            "UPDATE task_cards c SET position = r.n * :s FROM (SELECT id, row_number() OVER (ORDER BY position, created_at)"
            " AS n FROM task_cards WHERE list_id = :l AND archived_at IS NULL) r WHERE c.id = r.id"),
            {"l": list_id, "s": STEP})


CARD_SQL = (
    "SELECT c.id, c.venture_id, c.board_id, c.list_id, c.title_enc, c.description_enc, c.checklist_enc, c.labels,"
    " c.position, c.due_date, c.done_at, c.archived_at, c.created_at, c.updated_at, c.assignee_id,"
    " u.full_name AS assignee_name, u.email AS assignee_email,"
    " f.statement_enc, f.owner AS fact_owner, f.source_start_s, ch.id AS chunk_id, d.id AS document_id,"
    " d.title AS document_title"
    " FROM task_cards c LEFT JOIN users u ON u.id = c.assignee_id"
    " LEFT JOIN facts f ON f.id = c.fact_id LEFT JOIN chunks ch ON ch.id = f.source_chunk_id"
    " LEFT JOIN documents d ON d.id = ch.document_id")


async def _cards(db, svc, rows) -> list[TaskCardOut]:
    crypto = EnvelopeCrypto(db, svc.keys)
    out = []
    for r in rows:
        title = await crypto.decrypt_str(r.venture_id, TITLE, r.title_enc)
        if title is None and r.statement_enc is not None:
            title = (await crypto.decrypt(r.venture_id, memory.FACT_PURPOSE, r.statement_enc)).decode()
        checklist = await crypto.decrypt_str(r.venture_id, CHECK, r.checklist_enc)
        out.append(TaskCardOut(
            id=r.id, board_id=r.board_id, list_id=r.list_id, title=title or "(untitled)",
            description=await crypto.decrypt_str(r.venture_id, DESC, r.description_enc) or "",
            checklist=[TaskCheckItem(**i) for i in json.loads(checklist)] if checklist else [],
            labels=[TaskLabel(**x) for x in (r.labels or [])], position=r.position,
            assignee=VenturePerson(user_id=r.assignee_id, full_name=r.assignee_name or "", email=r.assignee_email or "")
            if r.assignee_id else None,
            due_date=r.due_date, done_at=r.done_at, archived=r.archived_at is not None,
            source=TaskCardSource(document_id=r.document_id, document_title=r.document_title, chunk_id=r.chunk_id,
                              source_start_s=r.source_start_s, owner=r.fact_owner) if r.document_id else None,
            created_at=r.created_at, updated_at=r.updated_at))
    return out


async def _card(db, svc, card_id: uuid.UUID) -> TaskCardOut:
    rows = (await db.execute(text(CARD_SQL + " WHERE c.id = :id"), {"id": card_id})).all()
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "card not found")
    return (await _cards(db, svc, rows))[0]


# ------------------------------------------------------------------ boards --
@router.get("/ventures/{venture_id}/boards", response_model=list[TaskBoardOut])
async def list_boards(venture_id: uuid.UUID, db: TenantDB) -> list[TaskBoardOut]:
    await venture_org(db, venture_id)
    try:
        async with db.begin_nested():
            await db.execute(text("SELECT default_task_board(:v)"), {"v": venture_id})
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    rows = (await db.execute(text(
        "SELECT b.id, b.name, b.position, b.is_default,"
        " (SELECT count(*) FROM task_cards c WHERE c.board_id = b.id AND c.archived_at IS NULL) AS cards"
        " FROM task_boards b WHERE b.venture_id = :v ORDER BY b.is_default DESC, b.position, b.created_at"),
        {"v": venture_id})).all()
    return [TaskBoardOut(**r._mapping) for r in rows]


@router.post("/ventures/{venture_id}/boards", response_model=TaskBoardOut, status_code=201)
async def create_board(venture_id: uuid.UUID, body: TaskBoardIn, user_id: UserId, db: TenantDB) -> TaskBoardOut:
    org = await _require_write(db, venture_id)
    try:
        async with db.begin_nested():
            pos = (await db.execute(text("SELECT coalesce(max(position), 0) + :s FROM task_boards WHERE venture_id = :v"),
                                    {"v": venture_id, "s": STEP})).scalar()
            row = (await db.execute(text(
                "INSERT INTO task_boards (org_id, venture_id, name, position, created_by) VALUES (:o, :v, :n, :p, :u)"
                " RETURNING id, name, position, is_default"),
                {"o": org, "v": venture_id, "n": body.name.strip(), "p": pos, "u": user_id})).first()
            for i, (name, done) in enumerate((("To do", False), ("In progress", False), ("Review", False), ("Done", True))):
                await db.execute(text(
                    "INSERT INTO task_lists (org_id, venture_id, board_id, name, position, is_done)"
                    " VALUES (:o, :v, :b, :n, :p, :d)"),
                    {"o": org, "v": venture_id, "b": row.id, "n": name, "p": (i + 1) * STEP, "d": done})
    except DBAPIError as exc:
        raise_for_db(exc, "venture not found")
    return TaskBoardOut(**row._mapping)


@router.get("/ventures/{venture_id}/boards/{board_id}", response_model=TaskBoardDetail)
async def get_board(venture_id: uuid.UUID, board_id: uuid.UUID, db: TenantDB, svc: Svc,
                    archived: bool = False) -> TaskBoardDetail:
    await venture_org(db, venture_id)
    b = (await db.execute(text("SELECT id, name, position, is_default FROM task_boards WHERE venture_id = :v AND id = :b"),
                          {"v": venture_id, "b": board_id})).first()
    if b is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "board not found")
    lists = (await db.execute(text("SELECT id, name, position, is_done FROM task_lists WHERE board_id = :b"
                                   " ORDER BY position, created_at"), {"b": board_id})).all()
    rows = (await db.execute(text(
        CARD_SQL + " WHERE c.board_id = :b AND (c.archived_at IS NULL) <> :a ORDER BY c.position, c.created_at"),
        {"b": board_id, "a": archived})).all()
    cards = await _cards(db, svc, rows)
    by_list: dict[uuid.UUID, list[TaskCardOut]] = {}
    for c in cards:
        by_list.setdefault(c.list_id, []).append(c)
    return TaskBoardDetail(**b._mapping, cards=len(cards), can_edit=await _can_write(db, venture_id),
                       lists=[TaskListOut(**r._mapping, cards=by_list.get(r.id, [])) for r in lists])


@router.patch("/ventures/{venture_id}/boards/{board_id}", response_model=TaskBoardOut)
async def update_board(venture_id: uuid.UUID, board_id: uuid.UUID, body: TaskBoardPatch, db: TenantDB) -> TaskBoardOut:
    await _require_write(db, venture_id)
    row = (await db.execute(text(
        "UPDATE task_boards SET name = coalesce(:n, name), position = coalesce(:p, position), updated_at = now()"
        " WHERE venture_id = :v AND id = :b RETURNING id, name, position, is_default"),
        {"n": body.name.strip() if body.name else None, "p": body.position, "v": venture_id, "b": board_id})).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "board not found")
    return TaskBoardOut(**row._mapping)


@router.delete("/ventures/{venture_id}/boards/{board_id}", status_code=204)
async def delete_board(venture_id: uuid.UUID, board_id: uuid.UUID, db: TenantDB) -> None:
    """Only a board without open cards; its archived cards move to the main board's archive."""
    await venture_org(db, venture_id)
    try:
        async with db.begin_nested():
            await db.execute(text("SELECT delete_task_board(:v, :b)"), {"v": venture_id, "b": board_id})
    except DBAPIError as exc:
        raise_for_db(exc, "board not found")


# ------------------------------------------------------------------- lists --
@router.post("/ventures/{venture_id}/boards/{board_id}/lists", response_model=TaskListOut, status_code=201)
async def create_list(venture_id: uuid.UUID, board_id: uuid.UUID, body: TaskListIn, db: TenantDB) -> TaskListOut:
    org = await _require_write(db, venture_id)
    try:
        async with db.begin_nested():
            pos = body.position if body.position is not None else (await db.execute(text(
                "SELECT coalesce(max(position), 0) + :s FROM task_lists WHERE board_id = :b"),
                {"b": board_id, "s": STEP})).scalar()
            row = (await db.execute(text(
                "INSERT INTO task_lists (org_id, venture_id, board_id, name, position) VALUES (:o, :v, :b, :n, :p)"
                " RETURNING id, name, position, is_done"),
                {"o": org, "v": venture_id, "b": board_id, "n": body.name.strip(), "p": pos})).first()
    except DBAPIError as exc:
        raise_for_db(exc, "board not found")
    return TaskListOut(**row._mapping, cards=[])


@router.patch("/ventures/{venture_id}/lists/{list_id}", response_model=TaskListOut)
async def update_list(venture_id: uuid.UUID, list_id: uuid.UUID, body: TaskListPatch, db: TenantDB) -> TaskListOut:
    await _require_write(db, venture_id)
    row = (await db.execute(text(
        "UPDATE task_lists SET name = coalesce(:n, name), position = coalesce(:p, position),"
        " is_done = coalesce(:d, is_done) WHERE venture_id = :v AND id = :l RETURNING id, name, position, is_done"),
        {"n": body.name.strip() if body.name else None, "p": body.position, "d": body.is_done,
         "v": venture_id, "l": list_id})).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "list not found")
    return TaskListOut(**row._mapping, cards=[])


@router.delete("/ventures/{venture_id}/lists/{list_id}", status_code=204)
async def delete_list(venture_id: uuid.UUID, list_id: uuid.UUID, db: TenantDB) -> None:
    """Only a list without open cards; its archived cards are re-filed under another list."""
    await venture_org(db, venture_id)
    try:
        async with db.begin_nested():
            await db.execute(text("SELECT delete_task_list(:v, :l)"), {"v": venture_id, "l": list_id})
    except DBAPIError as exc:
        raise_for_db(exc, "list not found")


# ------------------------------------------------------------------- cards --
@router.post("/ventures/{venture_id}/cards", response_model=TaskCardOut, status_code=201)
async def create_card(venture_id: uuid.UUID, body: TaskCardIn, user_id: UserId, db: TenantDB, svc: Svc) -> TaskCardOut:
    org = await _require_write(db, venture_id)
    lst = (await db.execute(text("SELECT board_id, is_done FROM task_lists WHERE venture_id = :v AND id = :l"),
                            {"v": venture_id, "l": body.list_id})).first()
    if lst is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "list not found")
    title = await EnvelopeCrypto(db, svc.keys).encrypt(venture_id, TITLE, body.title.strip())
    pos = body.position if body.position is not None else await _bottom(db, body.list_id)
    try:
        async with db.begin_nested():
            cid = (await db.execute(text(
                "INSERT INTO task_cards (org_id, venture_id, board_id, list_id, title_enc, position, created_by, done_at)"
                " VALUES (:o, :v, :b, :l, :t, :p, :u, CASE WHEN :d THEN now() END) RETURNING id"),
                {"o": org, "v": venture_id, "b": lst.board_id, "l": body.list_id, "t": title, "p": pos, "u": user_id,
                 "d": lst.is_done})).scalar_one()
    except DBAPIError as exc:
        raise_for_db(exc, "list not found")
    return await _card(db, svc, cid)


@router.patch("/ventures/{venture_id}/cards/{card_id}", response_model=TaskCardOut)
async def update_card(venture_id: uuid.UUID, card_id: uuid.UUID, body: TaskCardPatch, db: TenantDB, svc: Svc) -> TaskCardOut:
    await _require_write(db, venture_id)
    crypto = EnvelopeCrypto(db, svc.keys)
    sets: list[str] = []
    params: dict[str, Any] = {"v": venture_id, "c": card_id}
    if body.title is not None:
        sets.append("title_enc = :t")
        params["t"] = await crypto.encrypt(venture_id, TITLE, body.title)
    if body.description is not None:
        sets.append("description_enc = :d")
        params["d"] = await crypto.encrypt(venture_id, DESC, body.description) if body.description else None
    if body.checklist is not None:
        sets.append("checklist_enc = :k")
        params["k"] = (await crypto.encrypt(venture_id, CHECK, json.dumps([i.model_dump() for i in body.checklist]))
                       if body.checklist else None)
    if body.labels is not None:
        sets.append("labels = CAST(:lb AS jsonb)")
        params["lb"] = json.dumps([x.model_dump() for x in body.labels])
    if body.clear_assignee:
        sets.append("assignee_id = NULL")
    elif body.assignee_id is not None:
        ok = (await db.execute(text("SELECT 1 FROM venture_people(:v) WHERE user_id = :u"),
                               {"v": venture_id, "u": body.assignee_id})).first()
        if ok is None:
            raise HTTPException(422, "that person is not on this business")
        sets.append("assignee_id = :a")
        params["a"] = body.assignee_id
    if body.clear_due_date:
        sets.append("due_date = NULL")
    elif body.due_date is not None:
        sets.append("due_date = :dd")
        params["dd"] = body.due_date
    if body.archived is not None:
        sets.append("archived_at = CASE WHEN :ar THEN coalesce(archived_at, now()) END")
        params["ar"] = body.archived
    if sets:
        try:
            async with db.begin_nested():
                res = await db.execute(text(f"UPDATE task_cards SET {', '.join(sets)}, updated_at = now()"
                                            " WHERE venture_id = :v AND id = :c"), params)
        except DBAPIError as exc:
            raise_for_db(exc, "card not found")
        if res.rowcount == 0:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "card not found")
    return await _card(db, svc, card_id)


@router.post("/ventures/{venture_id}/cards/{card_id}/move", response_model=TaskCardOut)
async def move_card(venture_id: uuid.UUID, card_id: uuid.UUID, body: TaskCardMove, db: TenantDB, svc: Svc) -> TaskCardOut:
    """Drag and drop: into any list on any board of the same business, at a position."""
    await _require_write(db, venture_id)
    lst = (await db.execute(text("SELECT board_id, is_done FROM task_lists WHERE venture_id = :v AND id = :l"),
                            {"v": venture_id, "l": body.list_id})).first()
    if lst is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "list not found")
    pos = body.position if body.position is not None else await _bottom(db, body.list_id)
    try:
        async with db.begin_nested():
            res = await db.execute(text(
                "UPDATE task_cards SET board_id = :b, list_id = :l, position = :p, archived_at = NULL, updated_at = now(),"
                " done_at = CASE WHEN :d THEN coalesce(CASE WHEN list_id = :l THEN done_at END, now()) END"
                " WHERE venture_id = :v AND id = :c"),
                {"b": lst.board_id, "l": body.list_id, "p": pos, "d": lst.is_done, "v": venture_id, "c": card_id})
    except DBAPIError as exc:
        raise_for_db(exc, "card not found")
    if res.rowcount == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "card not found")
    await _renumber_if_crowded(db, body.list_id)
    return await _card(db, svc, card_id)


@router.get("/ventures/{venture_id}/people", response_model=list[VenturePerson])
async def people(venture_id: uuid.UUID, db: TenantDB) -> list[VenturePerson]:
    """Who cards on this business can be assigned to."""
    await venture_org(db, venture_id)
    rows = (await db.execute(text("SELECT * FROM venture_people(:v)"), {"v": venture_id})).all()
    return [VenturePerson(**r._mapping) for r in rows]
