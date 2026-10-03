"use client";

import { useMutation } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { WorkflowSettings } from "@/components/settings/workflows";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap } from "@/lib/api";
import { useVenture } from "@/lib/venture";

export default function AgentsPage() {
  const v = useVenture();
  const router = useRouter();
  const toast = useToast();
  const sample = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/sample-run", { params: { path: { venture_id: v.id } } })),
    onSuccess: (r) => {
      toast.success("Sample enquiry started", "Watch the agent work; a draft reply will appear in your Inbox for approval.");
      router.push(`/v/${v.id}/runs/${r.run_id}`);
    },
    onError: (e) => toast.error("Could not start the sample", errorMessage(e)),
  });
  return (
    <>
      <PageHeader
        eyebrow={v.venture_name}
        title="Agents"
        description="Each agent drafts; you approve. Tell them how your business works in plain language, switch steps on or off, and they follow it on every run."
        actions={
          <Button icon={<Sparkles className="h-4 w-4" />} loading={sample.isPending} onClick={() => sample.mutate()}>
            Try with a sample enquiry
          </Button>
        }
      />
      <WorkflowSettings ventureId={v.id} kind={v.kind} canAdmin={v.can_admin || v.is_owner} />
    </>
  );
}
