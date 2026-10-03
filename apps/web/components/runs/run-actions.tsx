"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap } from "@/lib/api";

export function RetryRunButton({ ventureId, runId, size = "sm" }: { ventureId: string; runId: string; size?: "sm" | "md" }) {
  const qc = useQueryClient();
  const toast = useToast();
  const m = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/runs/{run_id}/retry", { params: { path: { venture_id: ventureId, run_id: runId } } })),
    onSuccess: () => {
      toast.success("Run re-queued", "It will resume from the failed step.");
      void qc.invalidateQueries({ queryKey: ["runs", ventureId] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e) => toast.error("Could not retry", errorMessage(e)),
  });
  return (
    <Button size={size} onClick={() => m.mutate()} loading={m.isPending} icon={<RotateCcw className="h-3.5 w-3.5" />}>
      Retry
    </Button>
  );
}

export function CancelRunButton({ ventureId, runId }: { ventureId: string; runId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const m = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/runs/{run_id}/cancel", { params: { path: { venture_id: ventureId, run_id: runId } } })),
    onSuccess: () => {
      toast.success("Run cancelled");
      void qc.invalidateQueries({ queryKey: ["runs", ventureId] });
    },
    onError: (e) => toast.error("Could not cancel", errorMessage(e)),
  });
  return (
    <Button size="sm" variant="outline" onClick={() => m.mutate()} loading={m.isPending} icon={<Ban className="h-3.5 w-3.5" />}>
      Cancel run
    </Button>
  );
}

export const WORKFLOW_LABEL: Record<string, string> = {
  inbox_assistant: "Inbox assistant",
  lead_triage: "Lead triage",
  loan_verification: "Loan verification",
  kitchen_daily: "Kitchen daily plan",
  meeting_digest: "Meeting digest",
};

export function workflowLabel(w: string): string {
  return WORKFLOW_LABEL[w] ?? w.replace(/_/g, " ");
}
