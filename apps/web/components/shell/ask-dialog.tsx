"use client";

import { useMutation } from "@tanstack/react-query";
import { CornerDownLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AnswerView } from "@/components/knowledge/answer";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/field";
import { InlineError } from "@/components/ui/states";
import { api, unwrap } from "@/lib/api";
import { useAccess } from "@/lib/access";
import { VoiceButton } from "./voice-button";

export function AskDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { org } = useAccess();
  const [q, setQ] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const ask = useMutation({
    mutationFn: (question: string) =>
      unwrap(api.POST("/orgs/{org_id}/ask", { params: { path: { org_id: org!.id } }, body: { question } })),
  });

  useEffect(() => {
    if (open) setTimeout(() => ref.current?.focus(), 30);
  }, [open]);

  const submit = () => {
    const question = q.trim();
    if (question.length < 3 || !org) return;
    ask.mutate(question);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Ask across your ventures"
      description={`Answers come only from ${org?.name ?? "your organisation"}'s knowledge base you can access, with sources.`}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="space-y-3"
      >
        <label htmlFor="ask-q" className="sr-only">
          Question
        </label>
        <Textarea
          id="ask-q"
          ref={ref}
          rows={3}
          value={q}
          maxLength={2000}
          placeholder="e.g. What did we quote for the last Next.js + AI chatbot project?"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1 text-xs text-subtle">
            <VoiceButton />
            <span className="hidden sm:inline">Enter to ask · Shift+Enter for a new line</span>
          </div>
          <Button type="submit" variant="primary" loading={ask.isPending} disabled={q.trim().length < 3} icon={<CornerDownLeft className="h-3.5 w-3.5" />}>
            Ask
          </Button>
        </div>
      </form>
      <div className="mt-5" aria-live="polite">
        {ask.isError ? <InlineError error={ask.error} /> : null}
        {ask.data ? <AnswerView answer={ask.data} onNavigate={onClose} /> : null}
      </div>
    </Dialog>
  );
}
