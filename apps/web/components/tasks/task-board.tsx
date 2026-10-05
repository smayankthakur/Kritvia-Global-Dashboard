"use client";

import {
  closestCenter,
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { arrayMove, horizontalListSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useReducedMotion } from "motion/react";
import { Archive, ArchiveRestore, CircleCheckBig, KanbanSquare, MoreHorizontal, Plus, Settings2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, Input, Switch, Textarea } from "@/components/ui/field";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap } from "@/lib/api";
import { istDate } from "@/lib/format";
import {
  findList,
  moveInColumns,
  positionBetween,
  positionInColumn,
  toColumns,
  type Columns,
  type TaskBoard,
  type TaskBoardDetail,
  type TaskCard,
  type TaskList,
} from "@/lib/taskboard";
import { useVenture } from "@/lib/venture";
import { CardFace } from "./card-face";
import { CardSheet, useBoardDetail } from "./card-sheet";

type DragKind = "card" | "list" | "board";
const kindOf = (id: UniqueIdentifier | undefined | null): DragKind | null =>
  typeof id !== "string" ? null : id.startsWith("c:") ? "card" : id.startsWith("l:") ? "list" : id.startsWith("b:") ? "board" : null;
const raw = (id: UniqueIdentifier) => String(id).slice(2);

/**
 * Cards drop on the list under the pointer (nearest card within it); dropping on a board's
 * name in the switcher sends the card to that board. Lists sort among themselves.
 */
const collision: CollisionDetection = (args) => {
  const by = (k: DragKind) => args.droppableContainers.filter((c) => kindOf(c.id) === k);
  if (kindOf(args.active.id) === "list") return closestCenter({ ...args, droppableContainers: by("list") });
  const tab = pointerWithin({ ...args, droppableContainers: by("board") });
  if (tab.length) return tab;
  const column = pointerWithin({ ...args, droppableContainers: by("list") })[0];
  if (column) {
    const inside = args.droppableContainers.filter((c) => kindOf(c.id) === "card" && c.data.current?.listId === raw(column.id));
    if (!inside.length) return [column];
    return closestCenter({ ...args, droppableContainers: inside });
  }
  return closestCorners({ ...args, droppableContainers: [...by("card"), ...by("list")] });
};

export function TaskBoardView() {
  const v = useVenture();
  const qc = useQueryClient();
  const toast = useToast();
  const reduced = useReducedMotion();
  const today = istDate();

  const boards = useQuery({
    queryKey: ["task-boards", v.id],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/boards", { params: { path: { venture_id: v.id } } })),
  });
  const [picked, setPicked] = useState<string | null>(null);
  const active = boards.data?.find((b) => b.id === picked) ?? boards.data?.[0];
  const detail = useBoardDetail(v.id, active?.id);
  const board = detail.data;
  const key = ["task-board", v.id, active?.id, false];

  // What dragging rearranges: list order, and card ids per list.
  const [lists, setLists] = useState<string[]>([]);
  const [cols, setCols] = useState<Columns>({});
  const [dragId, setDragId] = useState<UniqueIdentifier | null>(null);
  const [overTab, setOverTab] = useState(false);
  const dragging = useRef(false);
  useEffect(() => {
    if (!board || dragging.current) return;
    setLists(board.lists.map((l) => l.id));
    setCols(toColumns(board));
  }, [board]);

  const cards = useMemo(() => new Map((board?.lists ?? []).flatMap((l) => l.cards.map((c) => [c.id, c] as const))), [board]);
  const listById = useMemo(() => new Map((board?.lists ?? []).map((l) => [l.id, l])), [board]);
  const [openCard, setOpenCard] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "new-board" | "board" | "archived" | { list: TaskList }>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["task-board", v.id] });
    void qc.invalidateQueries({ queryKey: ["task-boards", v.id] });
    void qc.invalidateQueries({ queryKey: ["facts", v.id] });
  };
  const moveCard = useMutation({
    mutationFn: (m: { card: string; list: string; position?: number }) =>
      unwrap(
        api.POST("/ventures/{venture_id}/cards/{card_id}/move", {
          params: { path: { venture_id: v.id, card_id: m.card } },
          body: { list_id: m.list, position: m.position },
        }),
      ),
    onError: (e) => {
      toast.error("Could not move the card", errorMessage(e));
      if (board) setCols(toColumns(board));
    },
    onSettled: refresh,
  });
  const moveList = useMutation({
    mutationFn: (m: { list: string; position: number }) =>
      unwrap(api.PATCH("/ventures/{venture_id}/lists/{list_id}", { params: { path: { venture_id: v.id, list_id: m.list } }, body: { position: m.position } })),
    onError: (e) => toast.error("Could not move the list", errorMessage(e)),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["task-board", v.id] }),
  });

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /** Put the new order into the cached board straight away, so nothing jumps back while saving. */
  const applyLocally = (cardId: string, listId: string, position: number) =>
    qc.setQueryData<TaskBoardDetail>(key, (b) => {
      if (!b) return b;
      const card = b.lists.flatMap((l) => l.cards).find((c) => c.id === cardId);
      if (!card) return b;
      const moved = { ...card, list_id: listId, position };
      return {
        ...b,
        lists: b.lists.map((l) => {
          const rest = l.cards.filter((c) => c.id !== cardId);
          return { ...l, cards: l.id === listId ? [...rest, moved].sort((a, z) => a.position - z.position) : rest };
        }),
      };
    });

  const onDragStart = ({ active: a }: DragStartEvent) => {
    dragging.current = true;
    setDragId(a.id);
  };

  const onDragOver = ({ active: a, over }: DragOverEvent) => {
    setOverTab(kindOf(over?.id) === "board");
    if (kindOf(a.id) !== "card" || !over) return;
    const k = kindOf(over.id);
    if (k !== "card" && k !== "list") return;
    const id = raw(a.id);
    setCols((c) => {
      const from = findList(c, id);
      const to = k === "list" ? raw(over.id) : findList(c, raw(over.id));
      if (!from || !to || from === to) return c;
      const overIdx = k === "card" ? c[to]!.indexOf(raw(over.id)) : c[to]!.length;
      const below = a.rect.current.translated && over.rect && a.rect.current.translated.top > over.rect.top + over.rect.height / 2;
      return moveInColumns(c, id, to, overIdx + (k === "card" && below ? 1 : 0));
    });
  };

  const onDragEnd = async ({ active: a, over }: DragEndEvent) => {
    dragging.current = false;
    setDragId(null);
    setOverTab(false);
    if (!board || !over) {
      if (board) setCols(toColumns(board));
      return;
    }
    if (kindOf(a.id) === "list") {
      const from = lists.indexOf(raw(a.id));
      const to = lists.indexOf(raw(over.id));
      if (from < 0 || to < 0 || from === to) return;
      const order = arrayMove(lists, from, to);
      setLists(order);
      const pos = (id: string | undefined) => (id ? listById.get(id)?.position : undefined);
      moveList.mutate({ list: raw(a.id), position: positionBetween(pos(order[to - 1]), pos(order[to + 1])) });
      return;
    }
    const id = raw(a.id);
    const card = cards.get(id);
    if (!card) return;
    if (kindOf(over.id) === "board") {
      const target = boards.data?.find((b) => b.id === raw(over.id));
      setCols(toColumns(board));
      if (!target || target.id === board.id) return;
      try {
        const t = await qc.fetchQuery({
          queryKey: ["task-board", v.id, target.id, false],
          queryFn: () => unwrap(api.GET("/ventures/{venture_id}/boards/{board_id}", { params: { path: { venture_id: v.id, board_id: target.id }, query: { archived: false } } })),
        });
        const first = t.lists.find((l) => !l.is_done) ?? t.lists[0];
        if (!first) return toast.error("That board has no lists", "Add a list to it first.");
        setCols((c) => ({ ...c, [card.list_id]: (c[card.list_id] ?? []).filter((x) => x !== id) }));
        moveCard.mutate({ card: id, list: first.id }, { onSuccess: () => toast.success(`Moved to ${target.name}`, `It’s at the bottom of “${first.name}”.`) });
      } catch (e) {
        toast.error("Could not move the card", errorMessage(e));
      }
      return;
    }
    let next = cols;
    const list = findList(next, id);
    if (!list) return;
    if (kindOf(over.id) === "card" && findList(next, raw(over.id)) === list) {
      const ids = next[list]!;
      const from = ids.indexOf(id);
      const to = ids.indexOf(raw(over.id));
      if (from !== to) next = { ...next, [list]: arrayMove(ids, from, to) };
    }
    setCols(next);
    const ids = next[list]!;
    const before = board.lists.find((l) => l.id === list)!.cards.map((c) => c.id);
    if (list === card.list_id && before.join() === ids.filter((x) => before.includes(x)).join() && ids.length === before.length) return;
    const position = positionInColumn(ids, id, (x) => cards.get(x)?.position);
    applyLocally(id, list, position);
    moveCard.mutate({ card: id, list, position });
  };

  if (boards.isError) return <ErrorState error={boards.error} onRetry={() => void boards.refetch()} />;
  if (!boards.data || !active) return <BoardSkeleton />;

  const dragKind = kindOf(dragId);
  const dragCard = dragKind === "card" ? cards.get(raw(dragId!)) : undefined;
  const dragList = dragKind === "list" ? listById.get(raw(dragId!)) : undefined;
  const edit = board?.can_edit ?? false;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={(e) => void onDragEnd(e)}
      onDragCancel={() => {
        dragging.current = false;
        setDragId(null);
        setOverTab(false);
        if (board) setCols(toColumns(board));
      }}
      accessibility={{
        screenReaderInstructions: {
          draggable: "To pick up a card or list, press space or enter. Use the arrow keys to move it, space or enter to drop, escape to cancel.",
        },
      }}
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Boards" className="flex min-w-0 flex-wrap items-center gap-1.5">
          {boards.data.map((b) => (
            <BoardTab key={b.id} board={b} selected={b.id === active.id} dragging={dragKind === "card"} onSelect={() => setPicked(b.id)} />
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1">
          {edit ? (
            <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setDialog("new-board")}>
              New board
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" icon={<Archive className="h-3.5 w-3.5" />} onClick={() => setDialog("archived")}>
            Archived
          </Button>
          {edit ? (
            <Button size="icon" variant="ghost" aria-label="Board settings" className="h-8 w-8" onClick={() => setDialog("board")}>
              <Settings2 className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </div>

      {detail.isError ? (
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      ) : !board || board.id !== active.id ? (
        <BoardSkeleton />
      ) : (
        <div className="kv-scroll -mx-4 flex items-start gap-3 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6" aria-label={`${board.name} board`}>
          <SortableContext items={lists.map((l) => `l:${l}`)} strategy={horizontalListSortingStrategy}>
            {lists.map((lid) => {
              const l = listById.get(lid);
              if (!l) return null;
              return (
                <ListColumn key={lid} list={l} ids={cols[lid] ?? []} cards={cards} edit={edit} today={today} dragId={dragId} onOpen={setOpenCard} onSettings={() => setDialog({ list: l })} />
              );
            })}
          </SortableContext>
          {edit ? <AddList boardId={board.id} /> : null}
          {!board.lists.length && !edit ? (
            <EmptyState icon={KanbanSquare} title="No lists on this board" description="Someone who can edit this business can add lists." />
          ) : null}
        </div>
      )}

      <DragOverlay dropAnimation={reduced ? null : { duration: 200, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }}>
        {dragCard ? (
          <CardFace card={dragCard} done={!!listById.get(findList(cols, dragCard.id) ?? "")?.is_done} today={today} lifted
            className={cn("w-[17rem] origin-top-left cursor-grabbing transition-[scale,opacity,translate] duration-200", overTab && "translate-x-14 translate-y-10 scale-50 opacity-80")}
          />
        ) : dragList ? (
          <div className="glass kv-drag-tilt w-72 rounded-2xl border p-3">
            <p className="px-1 text-sm font-semibold text-fg">{dragList.name}</p>
            <p className="mt-1 px-1 text-xs text-subtle">{cols[dragList.id]?.length ?? 0} cards</p>
          </div>
        ) : null}
      </DragOverlay>

      {board ? (
        <>
          <CardSheet card={openCard ? (cards.get(openCard) ?? null) : null} board={board} boards={boards.data} onClose={() => setOpenCard(null)} />
          <BoardDialogs
            dialog={dialog}
            board={board}
            close={() => setDialog(null)}
            onCreated={(id) => setPicked(id)}
            onDeleted={() => setPicked(null)}
            onOpenCard={setOpenCard}
          />
        </>
      ) : null}
    </DndContext>
  );
}

function BoardSkeleton() {
  return (
    <div className="flex gap-3 overflow-hidden" aria-busy="true" aria-label="Loading board">
      {[5, 3, 2, 1].map((n, i) => (
        <div key={i} className="glass w-72 shrink-0 space-y-2 rounded-2xl border p-3">
          <Skeleton className="h-5 w-24" />
          {Array.from({ length: n }, (_, j) => (
            <Skeleton key={j} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      ))}
    </div>
  );
}

function BoardTab({ board, selected, dragging, onSelect }: { board: TaskBoard; selected: boolean; dragging: boolean; onSelect: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: `b:${board.id}`, disabled: selected });
  return (
    <button
      ref={setNodeRef}
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-full border px-3.5 text-sm font-medium transition-[background-color,border-color,box-shadow,transform,color] duration-200",
        selected ? "border-transparent bg-accent text-accent-fg shadow-card" : "glass text-muted hover:text-fg",
        dragging && !selected && "border-dashed border-accent/60 text-fg",
        isOver && "scale-105 border-solid border-accent bg-accent-soft text-accent-soft-fg ring-4 ring-accent/20 motion-reduce:scale-100",
      )}
    >
      <KanbanSquare className="h-3.5 w-3.5" aria-hidden />
      {board.name}
      <span className={cn("rounded-full px-1.5 text-[11px] tabular-nums", selected ? "bg-white/20" : "bg-surface-3")}>{board.cards}</span>
    </button>
  );
}

function ListColumn({
  list,
  ids,
  cards,
  edit,
  today,
  dragId,
  onOpen,
  onSettings,
}: {
  list: TaskList;
  ids: string[];
  cards: Map<string, TaskCard>;
  edit: boolean;
  today: string;
  dragId: UniqueIdentifier | null;
  onOpen: (id: string) => void;
  onSettings: () => void;
}) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging, setActivatorNodeRef } = useSortable({
    id: `l:${list.id}`,
    disabled: !edit,
  });
  const receiving = kindOf(dragId) === "card" && ids.includes(raw(dragId!));
  return (
    <section
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      aria-label={list.name}
      className={cn(
        "glass flex max-h-[calc(100dvh-15rem)] min-h-24 w-72 shrink-0 flex-col rounded-2xl border transition-[box-shadow,border-color] duration-200",
        receiving && "border-accent/40 shadow-[0_0_0_3px_var(--accent-soft)]",
        isDragging && "opacity-40",
      )}
    >
      <header className="flex items-center gap-1 px-3 pt-3 pb-2">
        <h3
          ref={setActivatorNodeRef}
          {...(edit ? { ...attributes, ...listeners } : {})}
          className={cn("flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 text-sm font-semibold text-fg", edit && "cursor-grab active:cursor-grabbing")}
        >
          {list.is_done ? <CircleCheckBig className="h-4 w-4 shrink-0 text-success" aria-label="Done list" /> : null}
          <span className="truncate">{list.name}</span>
          <span className="ml-1 shrink-0 rounded-full bg-surface-3 px-1.5 text-[11px] font-medium text-muted tabular-nums">{ids.length}</span>
        </h3>
        {edit ? (
          <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`List settings for ${list.name}`} onClick={onSettings}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        ) : null}
      </header>
      <div className="kv-scroll min-h-2 flex-1 overflow-y-auto px-3 pb-1">
        <SortableContext items={ids.map((id) => `c:${id}`)} strategy={verticalListSortingStrategy}>
          <ol className="flex min-h-2 flex-col gap-2 pb-1">
            {ids.map((id) => {
              const c = cards.get(id);
              return c ? <SortableCard key={id} card={c} listId={list.id} done={list.is_done} edit={edit} today={today} onOpen={() => onOpen(id)} /> : null;
            })}
          </ol>
        </SortableContext>
      </div>
      {edit ? <AddCard listId={list.id} /> : <div className="h-2" />}
    </section>
  );
}

function SortableCard({ card, listId, done, edit, today, onOpen }: { card: TaskCard; listId: string; done: boolean; edit: boolean; today: string; onOpen: () => void }) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: `c:${card.id}`,
    data: { listId },
    disabled: !edit,
  });
  return (
    <li style={{ transform: CSS.Translate.toString(transform), transition }} className="list-none">
      <CardFace
        ref={setNodeRef}
        card={card}
        done={done}
        today={today}
        placeholder={isDragging}
        {...attributes}
        {...listeners}
        role="button"
        aria-roledescription={edit ? "draggable card" : undefined}
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !isDragging) {
            e.preventDefault();
            onOpen();
            return;
          }
          listeners?.onKeyDown?.(e);
        }}
        className={cn(edit ? "cursor-grab touch-manipulation" : "cursor-pointer", "animate-fade-in")}
      />
    </li>
  );
}

function useInvalidateBoard() {
  const v = useVenture();
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["task-board", v.id] });
    void qc.invalidateQueries({ queryKey: ["task-boards", v.id] });
  };
}

/** Trello's "+ Add a card": stays open after adding so you can type the next one. */
function AddCard({ listId }: { listId: string }) {
  const v = useVenture();
  const toast = useToast();
  const refresh = useInvalidateBoard();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const add = useMutation({
    mutationFn: (t: string) => unwrap(api.POST("/ventures/{venture_id}/cards", { params: { path: { venture_id: v.id } }, body: { list_id: listId, title: t } })),
    onSuccess: () => {
      setTitle("");
      refresh();
    },
    onError: (e) => toast.error("Could not add the card", errorMessage(e)),
  });
  const submit = () => {
    const t = title.trim();
    if (t) add.mutate(t);
  };
  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mx-2 mb-2 flex items-center gap-1.5 rounded-lg px-2 py-2 text-left text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
      >
        <Plus className="h-4 w-4" aria-hidden /> Add a card
      </button>
    );
  return (
    <div className="px-3 pb-3">
      <label htmlFor={`add-${listId}`} className="sr-only">
        Card title
      </label>
      <Textarea
        id={`add-${listId}`}
        autoFocus
        rows={2}
        maxLength={500}
        value={title}
        placeholder="Enter a title for this card…"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        className="resize-none"
      />
      <div className="mt-2 flex items-center gap-1.5">
        <Button size="sm" variant="primary" loading={add.isPending} disabled={!title.trim()} onClick={submit}>
          Add card
        </Button>
        <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Cancel" onClick={() => setOpen(false)}>
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function AddList({ boardId }: { boardId: string }) {
  const v = useVenture();
  const toast = useToast();
  const refresh = useInvalidateBoard();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const add = useMutation({
    mutationFn: (n: string) => unwrap(api.POST("/ventures/{venture_id}/boards/{board_id}/lists", { params: { path: { venture_id: v.id, board_id: boardId } }, body: { name: n } })),
    onSuccess: () => {
      setName("");
      refresh();
    },
    onError: (e) => toast.error("Could not add the list", errorMessage(e)),
  });
  return open ? (
    <form
      className="glass w-72 shrink-0 rounded-2xl border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) add.mutate(name.trim());
      }}
    >
      <label htmlFor="new-list" className="sr-only">
        List name
      </label>
      <Input id="new-list" autoFocus value={name} maxLength={60} placeholder="Enter list name…" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setOpen(false)} />
      <div className="mt-2 flex items-center gap-1.5">
        <Button size="sm" variant="primary" type="submit" loading={add.isPending} disabled={!name.trim()}>
          Add list
        </Button>
        <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Cancel" onClick={() => setOpen(false)}>
          <X className="h-4 w-4" />
        </Button>
      </div>
    </form>
  ) : (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="flex h-12 w-72 shrink-0 items-center gap-2 rounded-2xl border border-dashed border-border-strong bg-surface/40 px-4 text-sm font-medium text-muted backdrop-blur-md transition-colors hover:border-accent hover:bg-surface hover:text-fg"
    >
      <Plus className="h-4 w-4" aria-hidden /> Add another list
    </button>
  );
}

function BoardDialogs({
  dialog,
  board,
  close,
  onCreated,
  onDeleted,
  onOpenCard,
}: {
  dialog: null | "new-board" | "board" | "archived" | { list: TaskList };
  board: TaskBoardDetail;
  close: () => void;
  onCreated: (id: string) => void;
  onDeleted: () => void;
  onOpenCard: (id: string) => void;
}) {
  const v = useVenture();
  const toast = useToast();
  const refresh = useInvalidateBoard();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [isDone, setIsDone] = useState(false);
  const [confirm, setConfirm] = useState<null | "board" | "list">(null);
  const listDlg = dialog && typeof dialog === "object" ? dialog.list : null;
  useEffect(() => {
    if (dialog === "board") setName(board.name);
    else if (listDlg) {
      setName(listDlg.name);
      setIsDone(listDlg.is_done);
    } else setName("");
  }, [dialog, board.name, listDlg]);

  const done = (msg: string) => {
    toast.success(msg);
    refresh();
    close();
  };
  const fail = (what: string) => (e: unknown) => toast.error(what, errorMessage(e));
  const create = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/boards", { params: { path: { venture_id: v.id } }, body: { name: name.trim() } })),
    onSuccess: (b) => {
      onCreated(b.id);
      done(`Board “${b.name}” created`);
    },
    onError: fail("Could not create the board"),
  });
  const renameBoard = useMutation({
    mutationFn: () => unwrap(api.PATCH("/ventures/{venture_id}/boards/{board_id}", { params: { path: { venture_id: v.id, board_id: board.id } }, body: { name: name.trim() } })),
    onSuccess: () => done("Board renamed"),
    onError: fail("Could not rename the board"),
  });
  const deleteBoard = useMutation({
    mutationFn: () => unwrap(api.DELETE("/ventures/{venture_id}/boards/{board_id}", { params: { path: { venture_id: v.id, board_id: board.id } } })),
    onSuccess: () => {
      setConfirm(null);
      onDeleted();
      done("Board deleted");
    },
    onError: (e) => {
      setConfirm(null);
      fail("Could not delete the board")(e);
    },
  });
  const saveList = useMutation({
    mutationFn: () =>
      unwrap(api.PATCH("/ventures/{venture_id}/lists/{list_id}", { params: { path: { venture_id: v.id, list_id: listDlg!.id } }, body: { name: name.trim(), is_done: isDone } })),
    onSuccess: () => done("List saved"),
    onError: fail("Could not save the list"),
  });
  const deleteList = useMutation({
    mutationFn: () => unwrap(api.DELETE("/ventures/{venture_id}/lists/{list_id}", { params: { path: { venture_id: v.id, list_id: listDlg!.id } } })),
    onSuccess: () => {
      setConfirm(null);
      done("List deleted");
    },
    onError: (e) => {
      setConfirm(null);
      fail("Could not delete the list")(e);
    },
  });
  const archived = useBoardDetail(v.id, dialog === "archived" ? board.id : null, true);
  const restore = useMutation({
    mutationFn: (id: string) => unwrap(api.PATCH("/ventures/{venture_id}/cards/{card_id}", { params: { path: { venture_id: v.id, card_id: id } }, body: { archived: false, clear_assignee: false, clear_due_date: false } })),
    onSuccess: () => {
      toast.success("Card restored");
      void qc.invalidateQueries({ queryKey: ["task-board", v.id] });
      void qc.invalidateQueries({ queryKey: ["task-boards", v.id] });
      void qc.invalidateQueries({ queryKey: ["facts", v.id] });
    },
    onError: fail("Could not restore the card"),
  });

  const nameField = (label: string, max: number, onEnter: () => void): ReactNode => (
    <Field label={label}>
      <Input
        autoFocus
        value={name}
        maxLength={max}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && name.trim()) {
            e.preventDefault();
            onEnter();
          }
        }}
      />
    </Field>
  );
  const listCards = listDlg ? (board.lists.find((l) => l.id === listDlg.id)?.cards.length ?? 0) : 0;
  const archivedCards = archived.data?.lists.flatMap((l) => l.cards.map((c) => ({ c, list: l.name }))) ?? [];

  return (
    <>
      <Dialog
        open={dialog === "new-board"}
        onClose={close}
        title="New board"
        description="A board for a project, a team or a stream of work. It starts with To do, In progress, Review and Done."
        size="sm"
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>
              Create board
            </Button>
          </>
        }
      >
        {nameField("Board name", 80, () => create.mutate())}
      </Dialog>

      <Dialog
        open={dialog === "board"}
        onClose={close}
        title="Board settings"
        size="sm"
        footer={
          <>
            {!board.is_default ? (
              <Button variant="ghost" className="mr-auto text-danger hover:text-danger" onClick={() => setConfirm("board")}>
                Delete board
              </Button>
            ) : null}
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" disabled={!name.trim() || name.trim() === board.name} loading={renameBoard.isPending} onClick={() => renameBoard.mutate()}>
              Save
            </Button>
          </>
        }
      >
        {nameField("Board name", 80, () => renameBoard.mutate())}
        {board.is_default ? <p className="mt-3 text-xs text-subtle">This is the main board: tasks Kritvia finds in meetings, emails and documents land here. It can be renamed but not deleted.</p> : null}
      </Dialog>

      <Dialog
        open={!!listDlg}
        onClose={close}
        title="List settings"
        size="sm"
        footer={
          <>
            <Button variant="ghost" className="mr-auto text-danger hover:text-danger" disabled={listCards > 0} onClick={() => setConfirm("list")}>
              Delete list
            </Button>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" disabled={!name.trim()} loading={saveList.isPending} onClick={() => saveList.mutate()}>
              Save
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {nameField("List name", 60, () => saveList.mutate())}
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-fg">Cards here are done</p>
              <p className="text-xs text-subtle">Moving a task Kritvia found into this list marks it done; moving it out reopens it.</p>
            </div>
            <Switch checked={isDone} onChange={setIsDone} label="Cards here are done" />
          </div>
          {listCards > 0 ? <p className="text-xs text-subtle">To delete this list, move or archive its {listCards} card(s) first.</p> : null}
        </div>
      </Dialog>

      <Dialog open={dialog === "archived"} onClose={close} title="Archived cards" description={`On ${board.name}. Restoring puts a card back in its list.`} variant="sheet-right">
        {archived.isPending ? (
          <Skeleton className="h-20 w-full" />
        ) : archivedCards.length ? (
          <ul className="space-y-2">
            {archivedCards.map(({ c, list }) => (
              <li key={c.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface-strong p-3">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpenCard(c.id)}>
                  <p className="truncate text-sm text-fg">{c.title}</p>
                  <p className="text-xs text-subtle">in {list}</p>
                </button>
                {board.can_edit ? (
                  <Button size="sm" icon={<ArchiveRestore className="h-3.5 w-3.5" />} loading={restore.isPending && restore.variables === c.id} onClick={() => restore.mutate(c.id)}>
                    Restore
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={Archive} title="Nothing archived" description="Archived cards wait here; restore one to put it back." />
        )}
      </Dialog>

      <ConfirmDialog
        open={confirm === "board"}
        onClose={() => setConfirm(null)}
        onConfirm={() => deleteBoard.mutate()}
        loading={deleteBoard.isPending}
        title={`Delete “${board.name}”?`}
        description="Only an empty board can be deleted. Its archived cards move to the main board’s archive."
        confirmLabel="Delete board"
      />
      <ConfirmDialog
        open={confirm === "list"}
        onClose={() => setConfirm(null)}
        onConfirm={() => deleteList.mutate()}
        loading={deleteList.isPending}
        title={`Delete “${listDlg?.name ?? ""}”?`}
        description="Its archived cards stay in the archive, filed under another list."
        confirmLabel="Delete list"
      />
    </>
  );
}
