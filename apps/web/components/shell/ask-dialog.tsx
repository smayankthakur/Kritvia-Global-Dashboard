"use client";

import { useMutation } from "@tanstack/react-query";
import { CornerDownLeft, Sparkles } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AnswerView } from "@/components/knowledge/answer";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/field";
import { InlineError } from "@/components/ui/states";
import { api, unwrap } from "@/lib/api";
import { useAccess } from "@/lib/access";
import { VoiceButton } from "./voice-button";

export function AskDialog({ open, onClose, initialQuestion }: { open: boolean; onClose: () => void; initialQuestion?: string }) {
  const { org } = useAccess();
  const [q, setQ] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const router = useRouter();
  const ventureId = usePathname().match(/^\/v\/([0-9a-f-]{36})/)?.[1] ?? null;
  // "Do it": the assistant does the work in this business (any page, any agent), asking before it changes anything
  const doIt = useMutation({
    mutationFn: (request: string) => unwrap(api.POST("/ventures/{venture_id}/assistant", { params: { path: { venture_id: ventureId! } }, body: { request } })),
    onSuccess: () => {
      onClose();
      router.push(`/v/${ventureId}/assistant`);
    },
  });
  const ask = useMutation({
    mutationFn: (question: string) =>
      unwrap(api.POST("/orgs/{org_id}/ask", { params: { path: { org_id: org!.id } }, body: { question } })),
  });

  useEffect(() => {
    if (open) setTimeout(() => ref.current?.focus(), 30);
  }, [open]);

  // a question dictated in the voice widget's Ask mode: fill it in and ask straight away
  const { mutate } = ask;
  useEffect(() => {
    const seed = initialQuestion?.trim();
    if (open && seed && seed.length >= 3 && org) {
      setQ(seed);
      mutate(seed);
    }
  }, [open, initialQuestion, org, mutate]);

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
      title={ventureId ? "Ask or tell Kritvia" : "Ask across your ventures"}
      description={
        ventureId
          ? "Ask a question (answers come from your knowledge base, with sources), or press Do it and the assistant does the work: any page, any agent, several tasks at once. Anything that changes something waits for your yes."
          : `Answers come only from ${org?.name ?? "your organisation"}'s knowledge base you can access, with sources.`
      }
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
          <div className="flex items-center gap-2">
            {ventureId ? (
              <Button
                type="button"
                loading={doIt.isPending}
                disabled={q.trim().length < 3}
                icon={<Sparkles className="h-3.5 w-3.5" />}
                onClick={() => doIt.mutate(q.trim())}
              >
                Do it
              </Button>
            ) : null}
            <Button type="submit" variant="primary" loading={ask.isPending} disabled={q.trim().length < 3} icon={<CornerDownLeft className="h-3.5 w-3.5" />}>
              Ask
            </Button>
          </div>
        </div>
      </form>
      <div className="mt-5" aria-live="polite">
        {ask.isError ? <InlineError error={ask.error} /> : null}
        {doIt.isError ? <InlineError error={doIt.error} /> : null}
        {ask.data ? <AnswerView answer={ask.data} onNavigate={onClose} /> : null}
      </div>
    </Dialog>
  );
}
