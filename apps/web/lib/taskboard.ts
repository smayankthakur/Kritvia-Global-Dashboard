import type { Schemas } from "@/lib/api";

export type TaskBoard = Schemas["TaskBoardOut"];
export type TaskBoardDetail = Schemas["TaskBoardDetail"];
export type TaskList = Schemas["TaskListOut"];
export type TaskCard = Schemas["TaskCardOut"];
export type TaskLabel = Schemas["TaskLabel"];
export type CheckItem = Schemas["TaskCheckItem"];
export type LabelColor = TaskLabel["color"];

/** Trello-like label colours: a solid chip in light and dark themes, white or dark text for 4.5:1. */
export const LABEL_COLORS: { id: LabelColor; name: string; bg: string; fg: string }[] = [
  { id: "green", name: "Green", bg: "#16a34a", fg: "#ffffff" },
  { id: "yellow", name: "Yellow", bg: "#facc15", fg: "#1f2937" },
  { id: "orange", name: "Orange", bg: "#f97316", fg: "#1f2937" },
  { id: "red", name: "Red", bg: "#dc2626", fg: "#ffffff" },
  { id: "purple", name: "Purple", bg: "#9333ea", fg: "#ffffff" },
  { id: "blue", name: "Blue", bg: "#2563eb", fg: "#ffffff" },
  { id: "sky", name: "Sky", bg: "#38bdf8", fg: "#0c1a2b" },
  { id: "gray", name: "Gray", bg: "#64748b", fg: "#ffffff" },
];
export const labelStyle = (c: LabelColor) => {
  const x = LABEL_COLORS.find((l) => l.id === c) ?? LABEL_COLORS[7]!;
  return { backgroundColor: x.bg, color: x.fg };
};

export const STEP = 1024;

/** Position for an item dropped between two neighbours (either may be missing). */
export function positionBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return STEP;
  if (before === undefined) return after! / 2;
  if (after === undefined) return before + STEP;
  return (before + after) / 2;
}

/** How a due date reads: overdue (red), due today / soon (amber), done (green), or later. */
export function dueState(due: string | null | undefined, done: boolean, today: string): "done" | "overdue" | "soon" | "later" | null {
  if (!due) return null;
  if (done) return "done";
  if (due < today) return "overdue";
  const days = (Date.parse(due) - Date.parse(today)) / 86400_000;
  return days <= 1 ? "soon" : "later";
}

export function initials(name: string | null | undefined, email?: string | null): string {
  const src = (name || email || "?").trim();
  const parts = src.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[1]![0] : "")).toUpperCase();
}

export function checklistProgress(items: CheckItem[]): { done: number; total: number; pct: number } {
  const done = items.filter((i) => i.done).length;
  return { done, total: items.length, pct: items.length ? Math.round((done / items.length) * 100) : 0 };
}

/** Columns as ordered card ids per list, which is what dragging rearranges. */
export type Columns = Record<string, string[]>;

export function toColumns(b: TaskBoardDetail): Columns {
  return Object.fromEntries(b.lists.map((l) => [l.id, l.cards.map((c) => c.id)]));
}

export function findList(cols: Columns, cardId: string): string | undefined {
  return Object.keys(cols).find((l) => cols[l]!.includes(cardId));
}

/** Move a card to `toList` at `index` (clamped); returns new columns (the input is untouched). */
export function moveInColumns(cols: Columns, cardId: string, toList: string, index: number): Columns {
  const from = findList(cols, cardId);
  if (!from || !(toList in cols)) return cols;
  const next: Columns = { ...cols, [from]: cols[from]!.filter((id) => id !== cardId) };
  const target = [...next[toList]!];
  target.splice(Math.max(0, Math.min(index, target.length)), 0, cardId);
  next[toList] = target;
  return next;
}

/** Where a card now sits in its column, as a server position between its neighbours. */
export function positionInColumn(ids: string[], cardId: string, posOf: (id: string) => number | undefined): number {
  const i = ids.indexOf(cardId);
  return positionBetween(i > 0 ? posOf(ids[i - 1]!) : undefined, i < ids.length - 1 ? posOf(ids[i + 1]!) : undefined);
}

export const newId = () => Math.random().toString(36).slice(2, 10);
