"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Check, Inbox, PauseCircle, RotateCcw } from "lucide-react";
import Link from "next/link";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { ApprovalDetail } from "@/components/approvals/approval-detail";
import { workflowLabel } from "@/components/runs/run-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog } from "@/components/ui/dialog";
import { SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap } from "@/lib/api";
import { COLUMNS, ROLE_TITLES, formatSpend, groupTickets, humanNote, type ColumnKey, type RoleKey, type Ticket } from "@/lib/board";
import { formatRelative } from "@/lib/format";
import { WorkingDot } from "./org-chart";

const TONE: Record<ColumnKey, "warning" | "info" | "danger" | "success"> = {
  waiting_approval: "warning",
  open: "info",
  blocked: "danger",
  done: "success",
};

/** Four columns; cards slide between them as runs move. */
export function TicketBoard({ ventureId, tickets, canAdmin }: { ventureId: string; tickets: Ticket[]; canAdmin: boolean }) {
  const groups = groupTickets(tickets);
  const [reviewing, setReviewing] = useState<Ticket | null>(null);
  return (
    <LayoutGroup>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {COLUMNS.map((col) => (
          <section key={col.key} aria-label={col.title} className="min-w-0 rounded-lg border border-border bg-surface-2/60 p-2">
            <header className="mb-2 px-1.5 pt-1">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-fg">{col.title}</h3>
                <Badge tone={TONE[col.key]}>{groups[col.key].length}</Badge>
              </div>
              <p className="text-[11px] text-subtle">{col.hint}</p>
            </header>
            <ul className="flex min-h-16 flex-col gap-2">
              <AnimatePresence initial={false} mode="popLayout">
                {groups[col.key].map((t) => (
                  <TicketCard key={t.id} ticket={t} ventureId={ventureId} canAdmin={canAdmin} onReview={setReviewing} />
                ))}
              </AnimatePresence>
              {groups[col.key].length === 0 ? (
                <li className="rounded-md border border-dashed border-border px-3 py-5 text-center text-xs text-subtle">
                  {col.key === "waiting_approval" ? "Nothing waiting on you" : "Empty"}
                </li>
              ) : null}
            </ul>
          </section>
        ))}
      </div>
      {reviewing?.pending_approval_id ? (
        <ReviewDialog ventureId={ventureId} ticket={reviewing} onClose={() => setReviewing(null)} />
      ) : null}
    </LayoutGroup>
  );
}

function TicketCard({
  ticket: t,
  ventureId,
  canAdmin,
  onReview,
}: {
  ticket: Ticket;
  ventureId: string;
  canAdmin: boolean;
  onReview: (t: Ticket) => void;
}) {
  const reduce = useReducedMotion();
  const qc = useQueryClient();
  const toast = useToast();
  const retry = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/ventures/{venture_id}/runs/{run_id}/retry", { params: { path: { venture_id: ventureId, run_id: t.run_id! } } })),
    onSuccess: () => {
      toast.success("Retried", "The agent picks up where it stopped.");
      void qc.invalidateQueries({ queryKey: ["board", ventureId] });
    },
    onError: (e) => toast.error("Could not retry", errorMessage(e)),
  });
  const budget = t.status === "blocked" && /budget/i.test(t.note);
  return (
    <motion.li
      layout={!reduce}
      initial={reduce ? false : { opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduce ? undefined : { opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
      transition={{ type: "spring", stiffness: 300, damping: 28 }}
      className={cn(
        "rounded-md border border-border bg-surface p-3 shadow-card",
        t.status === "waiting_approval" && "border-warning/40",
        t.status === "blocked" && "border-danger/40",
      )}
    >
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-medium text-fg" title={t.title}>
          {t.title}
        </p>
        {t.status === "open" ? <WorkingDot className="mt-1.5 text-info" /> : null}
      </div>
      <p className="flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-subtle">
        <span>{t.workflow ? workflowLabel(t.workflow) : ROLE_TITLES[t.role as RoleKey] ?? t.role}</span>
        <span aria-hidden>·</span>
        <span>{formatRelative(t.updated_at)}</span>
        {t.cost_usd > 0 ? (
          <>
            <span aria-hidden>·</span>
            <span className="tabular-nums">{formatSpend(t.cost_usd)}</span>
          </>
        ) : null}
        {t.delegated_from ? (
          <>
            <span aria-hidden>·</span>
            <span>from {workflowLabel(t.delegated_from)}</span>
          </>
        ) : null}
      </p>
      {t.note && t.status !== "done" ? (
        <p className={cn("mt-1.5 line-clamp-2 text-xs", t.status === "blocked" ? "text-danger-fg" : "text-muted")}>
          {budget ? <PauseCircle className="mr-1 inline h-3 w-3" aria-hidden /> : null}
          {humanNote(t.note)}
        </p>
      ) : null}
      {t.status === "done" && t.note ? (
        <p className="mt-1.5 text-xs text-success-fg">
          <Check className="mr-1 inline h-3 w-3" aria-hidden />
          {t.note}
        </p>
      ) : null}
      <div className="mt-2.5 flex items-center gap-2">
        {t.status === "waiting_approval" && t.pending_approval_id ? (
          <Button size="sm" variant="primary" onClick={() => onReview(t)} icon={<Inbox className="h-3.5 w-3.5" />}>
            Review
          </Button>
        ) : null}
        {t.status === "blocked" && t.run_id && canAdmin ? (
          <Button size="sm" loading={retry.isPending} onClick={() => retry.mutate()} icon={<RotateCcw className="h-3.5 w-3.5" />}>
            Retry
          </Button>
        ) : null}
        {t.run_id ? (
          <Link
            href={`/v/${ventureId}/runs/${t.run_id}`}
            className="ml-auto inline-flex items-center gap-0.5 text-xs text-subtle hover:text-fg"
          >
            Timeline <ArrowUpRight className="h-3 w-3" aria-hidden />
          </Link>
        ) : null}
      </div>
    </motion.li>
  );
}

function ReviewDialog({ ventureId, ticket, onClose }: { ventureId: string; ticket: Ticket; onClose: () => void }) {
  const qc = useQueryClient();
  const approvalId = ticket.pending_approval_id!;
  const q = useQuery({
    queryKey: ["approval", ventureId, approvalId],
    queryFn: () =>
      unwrap(api.GET("/ventures/{venture_id}/approvals/{approval_id}", { params: { path: { venture_id: ventureId, approval_id: approvalId } } })),
  });
  return (
    <Dialog open onClose={onClose} title={ticket.title} description="What the agent wants to send. Approve, edit or reject." size="xl" variant="sheet-right">
      {q.data ? (
        <ApprovalDetail
          approval={q.data}
          onDecide={async (body) => {
            const out = await unwrap(
              api.POST("/ventures/{venture_id}/approvals/{approval_id}/decision", {
                params: { path: { venture_id: ventureId, approval_id: approvalId } },
                body,
              }),
            );
            void qc.invalidateQueries({ queryKey: ["board", ventureId] });
            void qc.invalidateQueries({ queryKey: ["dashboard"] });
            return out;
          }}
          onConflict={() => void qc.invalidateQueries({ queryKey: ["board", ventureId] })}
        />
      ) : (
        <SkeletonRows rows={6} />
      )}
    </Dialog>
  );
}
