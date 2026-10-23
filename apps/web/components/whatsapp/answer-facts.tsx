"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap } from "@/lib/api";

/** The answering machine's customer side: the inbox assistant's `answer_facts` option, where owners
 * look (the Chats page). Off by default; the same option is under Agents → Inbox assistant. */
export function AnswerFactsSwitch({ ventureId, canAdmin }: { ventureId: string; canAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const configs = useQuery({
    queryKey: ["workflow-configs", ventureId],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/workflow-configs", { params: { path: { venture_id: ventureId } } })),
  });
  const cfg = configs.data?.find((c) => c.workflow === "inbox_assistant");
  const settings = (cfg?.settings ?? {}) as Record<string, unknown>;
  const on = settings.answer_facts === true;
  const save = useMutation({
    mutationFn: (next: boolean) =>
      unwrap(
        api.PUT("/ventures/{venture_id}/workflow-configs/{workflow}", {
          params: { path: { venture_id: ventureId, workflow: "inbox_assistant" } },
          body: { enabled: cfg?.enabled ?? true, schedule: cfg?.schedule ?? null, settings: { ...settings, answer_facts: next }, instructions: cfg?.instructions ?? "" },
        }),
      ),
    onSuccess: (_, next) => {
      void qc.invalidateQueries({ queryKey: ["workflow-configs", ventureId] });
      toast.success(
        next ? "Answering by itself" : "Answers wait for your yes",
        next ? "Customers' questions about their own records now get an answer straight away." : "Every answer waits for your yes again.",
      );
    },
    onError: (e) => toast.error("Couldn't change it", errorMessage(e)),
  });
  if (!cfg?.enabled) return null;
  return (
    <Card className="flex items-start gap-3 p-4">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
        <Bot className="h-4 w-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium" id="answer-facts-label">
          Answer customers&apos; questions about their own records by themselves
        </p>
        <p className="mt-1 text-xs text-muted">
          How much they owe, a payment link, when their booking is, where their shipment is. Only their own records, found by the number or checked
          email they wrote from. The numbers come from your records, never written by AI. Everything else still waits for your yes.
        </p>
      </div>
      <Switch
        checked={on}
        disabled={!canAdmin || save.isPending}
        label="Answer customers' questions about their own records by themselves"
        onChange={(next) => save.mutate(next)}
      />
    </Card>
  );
}
