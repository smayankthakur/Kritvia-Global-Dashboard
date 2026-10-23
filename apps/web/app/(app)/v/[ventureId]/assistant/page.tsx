"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleDashed, Clock, CornerDownLeft, Plug, X } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, FormError, Textarea } from "@/components/ui/field";
import { Notice, PageHeader } from "@/components/ui/page";
import { EmptyState, QueryState, SkeletonRows } from "@/components/ui/states";
import { EXAMPLES, inProgress, toolLabel } from "@/components/assistant/labels";
import { SaveAsSkill } from "@/components/skills/skills";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { useVenture } from "@/lib/venture";

type Item = Schemas["AssistantItem"];

const STEP_ICON = {
  done: <Check className="h-3.5 w-3.5 text-success" aria-hidden />,
  failed: <X className="h-3.5 w-3.5 text-danger" aria-hidden />,
  "not approved": <X className="h-3.5 w-3.5 text-subtle" aria-hidden />,
  "waiting for approval": <Clock className="h-3.5 w-3.5 text-warning" aria-hidden />,
} as const;

function Request({ item, ventureId, canWrite }: { item: Item; ventureId: string; canWrite: boolean }) {
  const working = inProgress(item.status);
  const worked = item.status === "completed" && item.steps.some((s) => s.result === "done");
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 flex-1 font-medium whitespace-pre-wrap">{item.request}</p>
        <div className="flex items-center gap-2 text-xs text-subtle">
          <span>{formatRelative(item.created_at)}</span>
          {item.skill_id ? <Badge tone="info">skill</Badge> : null}
          {item.pending_approval_id ? <Badge tone="warning">Needs your yes</Badge> : <StatusBadge status={working ? "working" : item.status} />}
        </div>
      </div>
      {item.steps.length ? (
        <ol className="space-y-1 text-sm" aria-label="What the assistant did">
          {item.steps.map((s) => (
            <li key={`${s.n}-${s.tool}-${s.result}`} className="flex items-center gap-2 text-muted">
              {STEP_ICON[s.result]}
              <span>
                {toolLabel(s.tool)} <span className="text-subtle">· {s.result}</span>
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {working ? (
        <p className="flex items-center gap-2 text-sm text-subtle" role="status">
          <CircleDashed className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> Working on it…
        </p>
      ) : null}
      {item.pending_approval_id ? (
        <Notice tone="warning" title="A draft is waiting for your approval">
          Nothing is sent until you approve it.{" "}
          <Link href={`/inbox?id=${item.pending_approval_id}`} className="font-medium underline underline-offset-2">
            Review the draft
          </Link>
        </Notice>
      ) : null}
      {item.answer ? <p className="rounded-md border border-border bg-surface-2 p-3 text-sm whitespace-pre-wrap">{item.answer}</p> : null}
      {item.status === "failed" ? <p className="text-sm text-danger">Something went wrong. Try asking again in a moment.</p> : null}
      {worked && !item.skill_id && canWrite ? (
        <div className="flex justify-end">
          <SaveAsSkill ventureId={ventureId} runId={item.run_id} />
        </div>
      ) : null}
    </Card>
  );
}

function Composer({ ventureId }: { ventureId: string }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (request: string) =>
      unwrap(api.POST("/ventures/{venture_id}/assistant", { params: { path: { venture_id: ventureId } }, body: { request } })),
    onSuccess: () => {
      setText("");
      setError(null);
      void qc.invalidateQueries({ queryKey: ["assistant", ventureId] });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const request = text.trim();
    if (request.length < 2) return setError("Write what you want done");
    m.mutate(request);
  };
  return (
    <form onSubmit={submit} className="space-y-2" noValidate>
      <Field label="What should Kritvia do?" hint="English, Hindi or Hinglish. Drafts wait for your approval before anything is sent.">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
          }}
          rows={3}
          maxLength={4000}
          placeholder={EXAMPLES[1]}
        />
      </Field>
      <FormError message={error} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" loading={m.isPending} icon={<CornerDownLeft className="h-4 w-4" />}>
          Ask
        </Button>
        <span className="text-xs text-subtle">Ctrl + Enter</span>
      </div>
      <div className="flex flex-wrap gap-2 pt-1" aria-label="Examples">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => setText(ex)}
            className="rounded-full border border-border px-3 py-1 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {ex}
          </button>
        ))}
      </div>
    </form>
  );
}

function AppsLink({ ventureId }: { ventureId: string }) {
  return (
    <Card className="flex flex-wrap items-center gap-3 p-4">
      <Plug className="h-5 w-5 text-subtle" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">Give the assistant more apps</p>
        <p className="text-sm text-muted">Connect the other apps you use, like Notion, HubSpot or Zapier, or any web app with an API, from the App store.</p>
      </div>
      <Link href={`/v/${ventureId}/apps`} className="text-sm font-medium text-accent underline-offset-2 hover:underline">
        Open the App store
      </Link>
    </Card>
  );
}

export default function AssistantPage() {
  const v = useVenture();
  const items = useQuery({
    queryKey: ["assistant", v.id],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/assistant", { params: { path: { venture_id: v.id }, query: { limit: 20 } } })),
    // keep polling while something is being worked on
    refetchInterval: (q) => ((q.state.data ?? []).some((i) => inProgress(i.status)) ? 3000 : false),
  });
  return (
    <div className="space-y-6">
      <PageHeader title="Assistant" description="Ask Kritvia to do anything in plain words, several tasks at once: it can use every page and agent in Kritvia, looks things up, drafts and changes things, and asks for your yes before anything changes." />
      <Card className="p-4">
        <Composer ventureId={v.id} />
      </Card>
      <section aria-labelledby="history-heading" className="space-y-3">
        <h2 id="history-heading" className="font-semibold">
          Your requests
        </h2>
        <QueryState query={items} loading={<SkeletonRows rows={3} />}>
          {(list: Item[]) =>
            list.length ? (
              <div className="space-y-3">
                {list.map((i) => (
                  <Request key={i.run_id} item={i} ventureId={v.id} canWrite={v.access === "write"} />
                ))}
              </div>
            ) : (
              <EmptyState title="Nothing asked yet" description="Try one of the examples above." />
            )
          }
        </QueryState>
      </section>
      <AppsLink ventureId={v.id} />
    </div>
  );
}
