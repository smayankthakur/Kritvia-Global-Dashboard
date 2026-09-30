"use client";

import { useMutation } from "@tanstack/react-query";
import { CornerDownLeft, Upload } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { AnswerView } from "@/components/knowledge/answer";
import { AddNoteDialog, DocumentsTable, NoteButton, UploadDocumentDialog } from "@/components/knowledge/documents";
import { EntitiesBrowser } from "@/components/knowledge/entities";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page";
import { InlineError } from "@/components/ui/states";
import { Tabs } from "@/components/ui/tabs";
import { api, unwrap } from "@/lib/api";
import { useVenture } from "@/lib/venture";

function AskCard({ ventureId, name }: { ventureId: string; name: string }) {
  const [q, setQ] = useState("");
  const ask = useMutation({
    mutationFn: (question: string) => unwrap(api.POST("/ventures/{venture_id}/ask", { params: { path: { venture_id: ventureId } }, body: { question } })),
  });
  const submit = () => {
    if (q.trim().length >= 3) ask.mutate(q.trim());
  };
  return (
    <Card className="p-4 sm:p-5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="space-y-3"
      >
        <label htmlFor="kb-ask" className="text-sm font-semibold">
          Ask {name}&apos;s knowledge base
        </label>
        <Textarea
          id="kb-ask"
          rows={2}
          value={q}
          maxLength={2000}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="What did we decide about the Swiggy commission in last week's meeting?"
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-subtle">Every claim is cited. Sensitive sources are answered by the private (local) tier.</p>
          <Button type="submit" variant="primary" loading={ask.isPending} disabled={q.trim().length < 3} icon={<CornerDownLeft className="h-3.5 w-3.5" />}>
            Ask
          </Button>
        </div>
      </form>
      <div aria-live="polite">
        {ask.isError ? (
          <div className="mt-4">
            <InlineError error={ask.error} />
          </div>
        ) : null}
        {ask.data ? <AnswerView answer={ask.data} className="mt-5 border-t border-border pt-4" /> : null}
      </div>
    </Card>
  );
}

function KnowledgeView() {
  const v = useVenture();
  const router = useRouter();
  const tab = useSearchParams().get("tab") === "entities" ? "entities" : "documents";
  const [upload, setUpload] = useState(false);
  const [note, setNote] = useState(false);

  return (
    <>
      <PageHeader
        eyebrow={v.venture_name}
        title="Knowledge"
        description="Documents, notes, emails and transcripts — searchable, access-controlled and cited in every answer."
        actions={
          <>
            <NoteButton onClick={() => setNote(true)} />
            <Button variant="primary" icon={<Upload className="h-4 w-4" />} onClick={() => setUpload(true)}>
              Upload
            </Button>
          </>
        }
      />
      <div className="space-y-4">
        <AskCard ventureId={v.id} name={v.venture_name} />
        <Tabs
          label="Knowledge"
          value={tab}
          onChange={(t) => router.replace(`/v/${v.id}/knowledge${t === "entities" ? "?tab=entities" : ""}`, { scroll: false })}
          items={[
            { id: "documents", label: "Documents" },
            { id: "entities", label: "Entities" },
          ]}
        />
        <Card className="overflow-hidden">{tab === "entities" ? <EntitiesBrowser ventureId={v.id} /> : <DocumentsTable ventureId={v.id} />}</Card>
      </div>
      <UploadDocumentDialog open={upload} onClose={() => setUpload(false)} ventureId={v.id} />
      <AddNoteDialog open={note} onClose={() => setNote(false)} ventureId={v.id} />
    </>
  );
}

export default function KnowledgePage() {
  return (
    <Suspense>
      <KnowledgeView />
    </Suspense>
  );
}
