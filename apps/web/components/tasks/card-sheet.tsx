"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, ArrowRightLeft, Check, Plus, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatTimestamp } from "@/lib/format";
import { checklistProgress, LABEL_COLORS, labelStyle, newId, type TaskBoard, type TaskBoardDetail, type TaskCard } from "@/lib/taskboard";
import { useVenture } from "@/lib/venture";

type Patch = Partial<Schemas["TaskCardPatch"]>;

export function useBoardDetail(ventureId: string, boardId: string | null | undefined, archived = false) {
  return useQuery({
    queryKey: ["task-board", ventureId, boardId, archived],
    enabled: !!boardId,
    queryFn: () =>
      unwrap(
        api.GET("/ventures/{venture_id}/boards/{board_id}", {
          params: { path: { venture_id: ventureId, board_id: boardId! }, query: { archived } },
        }),
      ),
  });
}

/** Everything about one card: edit it, check things off, move it to another board. */
export function CardSheet({
  card,
  board,
  boards,
  onClose,
}: {
  card: TaskCard | null;
  board: TaskBoardDetail;
  boards: TaskBoard[];
  onClose: () => void;
}) {
  const v = useVenture();
  const qc = useQueryClient();
  const toast = useToast();
  const edit = board.can_edit;
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [item, setItem] = useState("");
  const [toBoard, setToBoard] = useState(board.id);
  const [toList, setToList] = useState("");

  useEffect(() => {
    if (!card) return;
    setTitle(card.title);
    setDesc(card.description);
    setToBoard(card.board_id);
    setToList(card.list_id);
    // reset only when another card opens, not on every save of this one
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.id]);

  const people = useQuery({
    queryKey: ["venture-people", v.id],
    enabled: !!card && edit,
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/people", { params: { path: { venture_id: v.id } } })),
  });
  const other = useBoardDetail(v.id, card && toBoard !== board.id ? toBoard : null);
  const targetLists = toBoard === board.id ? board.lists : (other.data?.lists ?? []);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["task-board", v.id] });
    void qc.invalidateQueries({ queryKey: ["task-boards", v.id] });
    void qc.invalidateQueries({ queryKey: ["facts", v.id] });
  };
  const save = useMutation({
    mutationFn: (body: Patch) =>
      unwrap(api.PATCH("/ventures/{venture_id}/cards/{card_id}", { params: { path: { venture_id: v.id, card_id: card!.id } }, body: { clear_assignee: false, clear_due_date: false, ...body } })),
    onSuccess: (c, body) => {
      qc.setQueryData<TaskBoardDetail>(["task-board", v.id, board.id, false], (b) =>
        b ? { ...b, lists: b.lists.map((l) => ({ ...l, cards: l.cards.map((x) => (x.id === c.id ? c : x)) })) } : b,
      );
      if (body.archived !== undefined) {
        toast.success(body.archived ? "Card archived" : "Card restored");
        refresh();
        if (body.archived) onClose();
      }
    },
    onError: (e) => toast.error("Could not save the card", errorMessage(e)),
  });
  const move = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/ventures/{venture_id}/cards/{card_id}/move", {
          params: { path: { venture_id: v.id, card_id: card!.id } },
          body: { list_id: toList },
        }),
      ),
    onSuccess: (c) => {
      const b = boards.find((x) => x.id === c.board_id);
      toast.success(c.board_id === board.id ? "Card moved" : `Moved to ${b?.name ?? "another board"}`);
      refresh();
      if (c.board_id !== board.id) onClose();
    },
    onError: (e) => toast.error("Could not move the card", errorMessage(e)),
  });

  if (!card) return <Dialog open={false} onClose={onClose} title="" />;
  const list = board.lists.find((l) => l.id === card.list_id);
  const check = checklistProgress(card.checklist);
  const setChecklist = (items: TaskCard["checklist"]) => save.mutate({ checklist: items });
  const toggleLabel = (color: (typeof LABEL_COLORS)[number]["id"]) => {
    const has = card.labels.some((l) => l.color === color);
    save.mutate({ labels: has ? card.labels.filter((l) => l.color !== color) : [...card.labels, { color, name: "" }] });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      variant="sheet-right"
      size="lg"
      title={
        <span className="text-xs font-medium tracking-wide text-subtle uppercase">
          {board.name} · {list?.name ?? "—"}
        </span>
      }
      footer={
        edit ? (
          <Button
            variant="ghost"
            icon={card.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
            onClick={() => save.mutate({ archived: !card.archived })}
            disabled={save.isPending}
          >
            {card.archived ? "Restore card" : "Archive card"}
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-6">
        <div>
          <label htmlFor="card-title" className="sr-only">
            Title
          </label>
          <Textarea
            id="card-title"
            value={title}
            rows={2}
            disabled={!edit}
            maxLength={500}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                (e.target as HTMLTextAreaElement).blur();
              }
            }}
            onBlur={() => {
              const t = title.trim();
              if (t && t !== card.title) save.mutate({ title: t });
              else setTitle(card.title);
            }}
            className="resize-none border-transparent bg-transparent px-1 text-lg font-semibold shadow-none hover:border-border focus:border-border"
          />
          {card.source ? (
            <p className="mt-1 flex flex-wrap items-center gap-1.5 px-1 text-xs text-subtle">
              <Sparkles className="h-3.5 w-3.5 text-accent" aria-hidden />
              Found by Kritvia in
              <Link href={`/v/${v.id}/knowledge/${card.source.document_id}?chunk=${card.source.chunk_id}`} className="text-accent hover:underline">
                {card.source.document_title}
                {card.source.source_start_s !== null ? ` @ ${formatTimestamp(card.source.source_start_s)}` : ""}
              </Link>
              {card.source.owner ? <span>· said for {card.source.owner}</span> : null}
            </p>
          ) : null}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Assigned to">
            <Select
              value={card.assignee?.user_id ?? ""}
              disabled={!edit}
              onChange={(e) => save.mutate(e.target.value ? { assignee_id: e.target.value } : { clear_assignee: true })}
            >
              <option value="">Nobody</option>
              {card.assignee && !people.data?.some((p) => p.user_id === card.assignee!.user_id) ? (
                <option value={card.assignee.user_id}>{card.assignee.full_name || card.assignee.email}</option>
              ) : null}
              {(people.data ?? []).map((p) => (
                <option key={p.user_id} value={p.user_id}>
                  {p.full_name || p.email}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Due date">
            <Input
              type="date"
              value={card.due_date ?? ""}
              disabled={!edit}
              onChange={(e) => save.mutate(e.target.value ? { due_date: e.target.value } : { clear_due_date: true })}
            />
          </Field>
        </div>

        <section aria-labelledby="labels-h">
          <h3 id="labels-h" className="mb-2 text-sm font-semibold text-fg">
            Labels
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {LABEL_COLORS.map((c) => {
              const on = card.labels.some((l) => l.color === c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={on}
                  aria-label={`${c.name} label`}
                  disabled={!edit || (!on && card.labels.length >= 10)}
                  onClick={() => toggleLabel(c.id)}
                  className={cn(
                    "flex h-8 w-11 items-center justify-center rounded-md transition-transform duration-150 hover:scale-105 disabled:opacity-50 motion-reduce:hover:scale-100",
                    on && "ring-2 ring-fg ring-offset-2 ring-offset-[var(--surface-strong)]",
                  )}
                  style={labelStyle(c.id)}
                >
                  {on ? <Check className="h-4 w-4" aria-hidden /> : null}
                </button>
              );
            })}
          </div>
          {card.labels.length ? (
            <div className="mt-3 space-y-2">
              {card.labels.map((l, i) => (
                <div key={`${l.color}-${i}`} className="flex items-center gap-2">
                  <span className="h-5 w-8 shrink-0 rounded" style={labelStyle(l.color)} aria-hidden />
                  <label htmlFor={`label-${i}`} className="sr-only">
                    Name for the {l.color} label
                  </label>
                  <Input
                    id={`label-${i}`}
                    defaultValue={l.name}
                    maxLength={24}
                    placeholder="Name (optional)"
                    disabled={!edit}
                    className="h-8"
                    onBlur={(e) => {
                      const name = e.target.value.trim();
                      if (name !== l.name) save.mutate({ labels: card.labels.map((x, j) => (j === i ? { ...x, name } : x)) });
                    }}
                  />
                </div>
              ))}
            </div>
          ) : null}
        </section>

        <section aria-labelledby="desc-h">
          <h3 id="desc-h" className="mb-2 text-sm font-semibold text-fg">
            Description
          </h3>
          <Textarea
            value={desc}
            rows={4}
            maxLength={10_000}
            disabled={!edit}
            placeholder={edit ? "Add more detail…" : "No description"}
            onChange={(e) => setDesc(e.target.value)}
          />
          {desc !== card.description ? (
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate({ description: desc })}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDesc(card.description)}>
                Cancel
              </Button>
            </div>
          ) : null}
        </section>

        <section aria-labelledby="check-h">
          <div className="mb-2 flex items-center justify-between">
            <h3 id="check-h" className="text-sm font-semibold text-fg">
              Checklist
            </h3>
            {check.total ? <span className="text-xs text-subtle tabular-nums">{check.pct}%</span> : null}
          </div>
          {check.total ? (
            <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={check.pct} aria-valuemin={0} aria-valuemax={100} aria-label="Checklist progress">
              <div
                className={cn("h-full rounded-full transition-[width,background-color] duration-300", check.pct === 100 ? "bg-success" : "bg-accent")}
                style={{ width: `${check.pct}%` }}
              />
            </div>
          ) : null}
          <ul className="space-y-1">
            {card.checklist.map((it) => (
              <li key={it.id} className="group flex items-center gap-2.5 rounded-md px-1 py-1 hover:bg-surface-2">
                <input
                  type="checkbox"
                  id={`chk-${it.id}`}
                  checked={it.done}
                  disabled={!edit}
                  onChange={() => setChecklist(card.checklist.map((x) => (x.id === it.id ? { ...x, done: !x.done } : x)))}
                  className="h-4 w-4 shrink-0 rounded border-border-strong accent-[var(--accent)]"
                />
                <label htmlFor={`chk-${it.id}`} className={cn("min-w-0 flex-1 text-sm break-words", it.done && "text-subtle line-through")}>
                  {it.text}
                </label>
                {edit ? (
                  <button
                    type="button"
                    aria-label={`Remove “${it.text}”`}
                    onClick={() => setChecklist(card.checklist.filter((x) => x.id !== it.id))}
                    className="rounded p-1 text-subtle opacity-0 group-hover:opacity-100 hover:text-danger focus-visible:opacity-100"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {edit && card.checklist.length < 50 ? (
            <form
              className="mt-2 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const text = item.trim();
                if (!text) return;
                setChecklist([...card.checklist, { id: newId(), text, done: false }]);
                setItem("");
              }}
            >
              <label htmlFor="new-item" className="sr-only">
                New checklist item
              </label>
              <Input id="new-item" value={item} maxLength={200} placeholder="Add an item" onChange={(e) => setItem(e.target.value)} className="h-8" />
              <Button size="sm" type="submit" icon={<Plus className="h-3.5 w-3.5" />} disabled={!item.trim()}>
                Add
              </Button>
            </form>
          ) : null}
        </section>

        {edit && !card.archived ? (
          <section aria-labelledby="move-h" className="rounded-xl border border-border bg-surface-2 p-4">
            <h3 id="move-h" className="mb-3 flex items-center gap-2 text-sm font-semibold text-fg">
              <ArrowRightLeft className="h-4 w-4 text-accent" aria-hidden /> Move
            </h3>
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <Field label="Board">
                <Select
                  value={toBoard}
                  onChange={(e) => {
                    setToBoard(e.target.value);
                    setToList(e.target.value === board.id ? card.list_id : "");
                  }}
                >
                  {boards.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="List">
                <Select value={toList} onChange={(e) => setToList(e.target.value)} disabled={!targetLists.length}>
                  {toList === "" ? <option value="">Choose a list</option> : null}
                  {targetLists.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button variant="primary" disabled={!toList || toList === card.list_id} loading={move.isPending} onClick={() => move.mutate()}>
                Move
              </Button>
            </div>
            <p className="mt-2 text-xs text-subtle">Tip: you can also drag a card onto another board’s name at the top.</p>
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}
