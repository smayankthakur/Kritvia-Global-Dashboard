"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Flag, Pencil } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page";
import { QueryState, Skeleton } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap } from "@/lib/api";
import type { Board } from "@/lib/board";
import { formatRelative } from "@/lib/format";
import { useVenture } from "@/lib/venture";
import { OrgChart } from "./org-chart";
import { TicketBoard } from "./ticket-board";

export function boardKey(ventureId: string) {
  return ["board", ventureId] as const;
}

export function BoardView() {
  const v = useVenture();
  const canAdmin = v.can_admin || v.is_owner;
  const q = useQuery({
    queryKey: boardKey(v.id),
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/board", { params: { path: { venture_id: v.id } } })),
    refetchInterval: 15_000,
  });
  const [missionOpen, setMissionOpen] = useState(false);
  return (
    <>
      <PageHeader
        eyebrow={v.venture_name}
        title="Board"
        description="Your agents as a small team: who is doing what, what needs your yes, and what each one costs this month."
        actions={
          canAdmin ? (
            <Button icon={<Flag className="h-4 w-4" />} onClick={() => setMissionOpen(true)}>
              {q.data?.mission ? "Change mission" : "Set a mission"}
            </Button>
          ) : null
        }
      />
      <QueryState query={q} loading={<BoardSkeleton />}>
        {(board) => (
          <div className="space-y-6">
            <Mission board={board} canAdmin={canAdmin} onEdit={() => setMissionOpen(true)} />
            <OrgChart ventureId={v.id} board={board} ownerName={v.venture_name} canAdmin={canAdmin} />
            <TicketBoard ventureId={v.id} tickets={board.tickets} canAdmin={canAdmin} />
          </div>
        )}
      </QueryState>
      {missionOpen ? <MissionDialog ventureId={v.id} current={q.data?.mission ?? null} onClose={() => setMissionOpen(false)} /> : null}
    </>
  );
}

function Mission({ board, canAdmin, onEdit }: { board: Board; canAdmin: boolean; onEdit: () => void }) {
  const reduce = useReducedMotion();
  if (!board.mission) {
    return (
      <motion.div
        initial={reduce ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-border-strong bg-surface px-4 py-3"
      >
        <p className="text-sm text-muted">
          <span className="font-medium text-fg">No mission yet.</span> One line on what the team is for this month; every agent reads it.
        </p>
        {canAdmin ? (
          <Button size="sm" variant="primary" onClick={onEdit}>
            Write it
          </Button>
        ) : null}
      </motion.div>
    );
  }
  return (
    <motion.div
      key={board.mission.id}
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative overflow-hidden rounded-lg border border-accent/30 bg-gradient-to-r from-accent-soft to-surface px-4 py-3.5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-accent-soft-fg">Mission</p>
          <p className="mt-0.5 text-base font-semibold text-fg">{board.mission.title}</p>
          {board.mission.note ? <p className="mt-1 text-sm text-muted">{board.mission.note}</p> : null}
          <p className="mt-1 text-[11.5px] text-subtle">Set {formatRelative(board.mission.updated_at)}</p>
        </div>
        {canAdmin ? (
          <Button size="icon" variant="ghost" aria-label="Change the mission" onClick={onEdit} icon={<Pencil className="h-4 w-4" />} />
        ) : null}
      </div>
    </motion.div>
  );
}

function MissionDialog({ ventureId, current, onClose }: { ventureId: string; current: Board["mission"]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState(current?.title ?? "");
  const [note, setNote] = useState(current?.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      unwrap(api.PUT("/ventures/{venture_id}/board/mission", { params: { path: { venture_id: ventureId } }, body: { title: title.trim(), note: note.trim() } })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: boardKey(ventureId) });
      toast.success("Mission set", "Your agents will read it on their next run.");
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Mission"
      description="One sentence your whole team works toward this month."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={!title.trim()} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Mission" error={error} required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Reply to every enquiry within an hour" autoFocus />
        </Field>
        <Field label="Note" hint="Optional. Anything the team should keep in mind.">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={3} />
        </Field>
      </div>
    </Dialog>
  );
}

function BoardSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading the board">
      <Skeleton className="h-16" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-40" />
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-32" />
        ))}
      </div>
    </div>
  );
}
