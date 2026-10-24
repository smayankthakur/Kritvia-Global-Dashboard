"use client";

import { Bot } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/api";
import { useAssistantSettings } from "./assistant-settings";

/** The answering machine's customer side: the inbox assistant's `answer_facts` option, where owners
 * look (the Chats page). Off by default; the same option is under Agents → Inbox assistant. */
export function AnswerFactsSwitch({ ventureId, canAdmin }: { ventureId: string; canAdmin: boolean }) {
  const toast = useToast();
  const { cfg, settings, saving, save } = useAssistantSettings(ventureId);
  const on = settings.answer_facts === true;
  // Only this setting is sent; the API keeps the rest (round 3, B11).
  const change = (next: boolean) =>
    save.mutate(
      { answer_facts: next },
      {
        onSuccess: () =>
          toast.success(
            next ? "Answering by itself" : "Answers wait for your yes",
            next ? "Customers' questions about their own records now get an answer straight away." : "Every answer waits for your yes again.",
          ),
        onError: (e) => toast.error("Couldn't change it", errorMessage(e)),
      },
    );
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
        disabled={!canAdmin || saving}
        label="Answer customers' questions about their own records by themselves"
        onChange={change}
      />
    </Card>
  );
}
