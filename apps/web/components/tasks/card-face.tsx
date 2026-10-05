"use client";

import { AlignLeft, CalendarDays, CheckSquare, Sparkles } from "lucide-react";
import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/components/ui/cn";
import { formatDate } from "@/lib/format";
import { checklistProgress, dueState, initials, labelStyle, type TaskCard } from "@/lib/taskboard";

const dueTone = {
  done: "bg-success-soft text-success-fg",
  overdue: "bg-danger-soft text-danger-fg",
  soon: "bg-warning-soft text-warning-fg",
  later: "text-subtle",
} as const;

export function Avatar({ name, email, className }: { name?: string | null; email?: string | null; className?: string }) {
  return (
    <span
      title={name || email || undefined}
      className={cn(
        "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(135deg,var(--accent),var(--accent-2))] text-[10px] font-semibold text-accent-fg ring-2 ring-[var(--surface-strong)]",
        className,
      )}
    >
      {initials(name, email)}
    </span>
  );
}

/** What a card looks like on a list (and under the cursor while dragging). */
export const CardFace = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement> & { card: TaskCard; done: boolean; today: string; lifted?: boolean; placeholder?: boolean }
>(function CardFace({ card, done, today, lifted, placeholder, className, ...rest }, ref) {
  const due = dueState(card.due_date, done, today);
  const check = checklistProgress(card.checklist);
  return (
    <div
      ref={ref}
      {...rest}
      className={cn(
        "group/card relative rounded-xl border border-border bg-surface-strong p-3 text-left text-sm shadow-card backdrop-blur-md",
        "transition-[box-shadow,border-color,opacity] duration-150 hover:border-border-strong hover:shadow-[var(--shadow-hover)]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        lifted && "kv-drag-tilt border-accent/50 bg-surface-solid",
        placeholder && "border-dashed border-accent/50 bg-accent-soft opacity-60 shadow-none [&>*]:invisible",
        className,
      )}
    >
      {card.labels.length ? (
        <div className="mb-2 flex flex-wrap gap-1">
          {card.labels.map((l, i) =>
            l.name ? (
              <span key={i} className="inline-flex h-5 max-w-full items-center truncate rounded px-2 text-[11px] font-semibold" style={labelStyle(l.color)}>
                {l.name}
              </span>
            ) : (
              <span key={i} className="h-2 w-10 rounded-full" style={labelStyle(l.color)} aria-label={`${l.color} label`} />
            ),
          )}
        </div>
      ) : null}
      <p className={cn("break-words leading-snug text-fg", done && "text-muted")}>{card.title}</p>
      {due || card.description || check.total || card.source || card.assignee ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
          {due ? (
            <span className={cn("inline-flex h-5 items-center gap-1 rounded px-1.5 font-medium", dueTone[due])} title={due === "overdue" ? "Overdue" : "Due date"}>
              <CalendarDays className="h-3 w-3" aria-hidden />
              {formatDate(card.due_date)}
            </span>
          ) : null}
          {card.description ? <AlignLeft className="h-3.5 w-3.5" aria-label="Has a description" /> : null}
          {check.total ? (
            <span
              className={cn("inline-flex h-5 items-center gap-1 rounded px-1.5 font-medium tabular-nums", check.done === check.total && "bg-success-soft text-success-fg")}
              title="Checklist"
            >
              <CheckSquare className="h-3 w-3" aria-hidden />
              {check.done}/{check.total}
            </span>
          ) : null}
          {card.source ? (
            <span className="inline-flex items-center gap-1 text-accent" title={`Found by Kritvia in “${card.source.document_title}”`}>
              <Sparkles className="h-3 w-3" aria-hidden />
              <span className="sr-only">Extracted by Kritvia</span>
            </span>
          ) : null}
          {card.assignee ? <Avatar name={card.assignee.full_name} email={card.assignee.email} className="ml-auto" /> : null}
        </div>
      ) : null}
    </div>
  );
});
