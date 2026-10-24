"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { ApiError, api, errorMessage, unwrap } from "@/lib/api";

/**
 * Delete a proposal (round 3, B8). One already sent to the client is the record of what was offered, so the
 * API refuses it at first (409); then we ask once more and delete it anyway if the owner says so.
 */
export function DeleteProposalButton({
  ventureId,
  proposal,
  onDeleted,
  iconOnly = false,
}: {
  ventureId: string;
  proposal: { id: string; title: string };
  onDeleted?: () => void;
  iconOnly?: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [step, setStep] = useState<"closed" | "confirm" | "sent">("closed");
  const del = useMutation({
    mutationFn: (force: boolean) =>
      unwrap(
        api.DELETE("/ventures/{venture_id}/proposals/{proposal_id}", {
          params: { path: { venture_id: ventureId, proposal_id: proposal.id }, query: force ? { force: true } : {} },
        }),
      ),
    onSuccess: () => {
      setStep("closed");
      toast.success("Proposal deleted");
      onDeleted?.();
      // The lists, not the deleted proposal's own page (it would only answer "not found" now).
      void qc.invalidateQueries({ queryKey: ["proposals", ventureId], predicate: (q) => q.queryKey[2] !== "detail" });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) setStep("sent");
      else {
        setStep("closed");
        toast.error("Could not delete the proposal", errorMessage(e));
      }
    },
  });
  return (
    <>
      {iconOnly ? (
        <Button size="icon" variant="ghost" aria-label={`Delete ${proposal.title}`} icon={<Trash2 className="h-4 w-4" />} onClick={() => setStep("confirm")} />
      ) : (
        <Button variant="ghost" className="text-danger hover:text-danger" icon={<Trash2 className="h-4 w-4" />} onClick={() => setStep("confirm")}>
          Delete
        </Button>
      )}
      <ConfirmDialog
        open={step === "confirm"}
        onClose={() => setStep("closed")}
        onConfirm={() => del.mutate(false)}
        loading={del.isPending}
        title="Delete this proposal?"
        description={`“${proposal.title}” is deleted. This can't be undone.`}
        confirmLabel="Delete proposal"
      />
      <ConfirmDialog
        open={step === "sent"}
        onClose={() => setStep("closed")}
        onConfirm={() => del.mutate(true)}
        loading={del.isPending}
        title="It was sent to the client. Delete anyway?"
        description="It is your record of what you offered them. Deleting it can't be undone."
        confirmLabel="Delete anyway"
      />
    </>
  );
}
