"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleDashed, ExternalLink, Globe, Lock, Send } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, FormError, Input, Textarea } from "@/components/ui/field";
import { Notice, PageHeader } from "@/components/ui/page";
import { EmptyState, QueryState, SkeletonRows } from "@/components/ui/states";
import { inProgress } from "@/components/assistant/labels";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { useVenture } from "@/lib/venture";

type Job = Schemas["BrowserJob"];

const BROWSER_EXAMPLES = [
  "Find the GST rate for printed paper cartons on the CBIC website",
  "Check Indigo's baggage allowance for a Delhi to Mumbai flight",
  "On sharmasweets.example, send a bulk order enquiry for 20 kg kaju katli for Sunday",
  "Kal Delhi mein mausam kaisa rahega?",
];

/** "sharmasweets.example/bulk" for a link label. */
function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    const path = x.pathname === "/" ? "" : x.pathname;
    return `${x.hostname.replace(/^www\./, "")}${path}`.slice(0, 60);
  } catch {
    return u.slice(0, 60);
  }
}

function JobCard({ job }: { job: Job }) {
  const working = inProgress(job.status);
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-medium whitespace-pre-wrap" translate="no">
            {job.task}
          </p>
          {job.url ? <p className="text-xs break-all text-subtle">Starting at {shortUrl(job.url)}</p> : null}
        </div>
        <div className="flex items-center gap-2 text-xs text-subtle">
          <span>{formatRelative(job.created_at)}</span>
          {job.pending_approval_id ? <Badge tone="warning">Needs your yes</Badge> : <StatusBadge status={working ? "working" : job.status} />}
        </div>
      </div>
      {working ? (
        <p className="flex items-center gap-2 text-sm text-subtle" role="status">
          <CircleDashed className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> Browsing… (one job at a time; it can take a minute)
        </p>
      ) : null}
      {job.form && job.pending_approval_id ? (
        <Notice tone="warning" title="A form is waiting for your yes">
          <dl className="mt-1 space-y-0.5 text-sm" translate="no">
            {job.form.map((f, i) => (
              <div key={`${i}-${f.label}`} className="flex gap-2">
                <dt className="shrink-0 text-subtle">{f.label}:</dt>
                <dd className="min-w-0 break-words">{f.value}</dd>
              </div>
            ))}
          </dl>
          <Link href={`/inbox?id=${job.pending_approval_id}`} className="mt-2 inline-block font-medium underline underline-offset-2">
            Review and send
          </Link>
        </Notice>
      ) : null}
      {job.answer ? (
        <p className="rounded-md border border-border bg-surface-2 p-3 text-sm whitespace-pre-wrap" translate="no">
          {job.answer}
        </p>
      ) : null}
      {job.sources.length ? (
        <div className="flex flex-wrap gap-2" aria-label="Pages it used">
          {job.sources.map((s) => (
            <a
              key={s}
              href={s}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-xs text-muted hover:bg-surface-2 hover:text-fg"
            >
              {shortUrl(s)} <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          ))}
        </div>
      ) : null}
      {job.status === "failed" ? <p className="text-sm text-danger">Something went wrong. Try again in a moment.</p> : null}
    </Card>
  );
}

function Composer({ ventureId, disabled }: { ventureId: string; disabled: boolean }) {
  const qc = useQueryClient();
  const [task, setTask] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/ventures/{venture_id}/browser", {
          params: { path: { venture_id: ventureId } },
          body: { task: task.trim(), url: url.trim() || null },
        }),
      ),
    onSuccess: () => {
      setTask("");
      setUrl("");
      setError(null);
      void qc.invalidateQueries({ queryKey: ["browser", ventureId] });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (task.trim().length < 5) return setError("Say what to do on the web");
    m.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <Field label="What should it do on the web?" hint="It reads pages and can fill in a form; a form is sent only after your yes.">
        <Textarea value={task} onChange={(e) => setTask(e.target.value)} rows={3} maxLength={1500} placeholder={BROWSER_EXAMPLES[0]} />
      </Field>
      <Field label="Start at (optional)" hint="A website or page. Leave empty and it searches the web.">
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="example.com/contact" inputMode="url" autoComplete="off" maxLength={2000} />
      </Field>
      <FormError message={error} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" loading={m.isPending} disabled={disabled} icon={<Send className="h-4 w-4" />}>
          Start
        </Button>
      </div>
      <div className="flex flex-wrap gap-2 pt-1" aria-label="Examples">
        {BROWSER_EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            onClick={() => setTask(ex)}
            className="rounded-full border border-border px-3 py-1 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {ex}
          </button>
        ))}
      </div>
    </form>
  );
}

export default function BrowserPage() {
  const v = useVenture();
  const status = useQuery({
    queryKey: ["browser-status", v.id],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/browser/status", { params: { path: { venture_id: v.id } } })),
  });
  const jobs = useQuery({
    queryKey: ["browser", v.id],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/browser", { params: { path: { venture_id: v.id }, query: { limit: 20 } } })),
    refetchInterval: (q) => ((q.state.data ?? []).some((j) => inProgress(j.status)) ? 3000 : false),
  });
  const note = status.data?.note ?? null;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Browser agent"
        description="Kritvia uses websites for you on a locked-down browser on our server: it looks things up and fills in forms."
      />
      {note ? (
        <Notice tone="info" title="Not available yet">
          {note}
        </Notice>
      ) : null}
      <Card className="p-4">
        <Composer ventureId={v.id} disabled={Boolean(note) || v.access !== "write"} />
      </Card>
      <ul className="grid gap-2 text-sm text-muted sm:grid-cols-3" aria-label="How it stays safe">
        <li className="flex gap-2 rounded-lg border border-border p-3">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-subtle" aria-hidden />
          Never signs in, pays, or types passwords, card numbers, OTPs, Aadhaar or PAN.
        </li>
        <li className="flex gap-2 rounded-lg border border-border p-3">
          <Send className="mt-0.5 h-4 w-4 shrink-0 text-subtle" aria-hidden />
          Pages are only read. A form is sent exactly as you approved it, never before.
        </li>
        <li className="flex gap-2 rounded-lg border border-border p-3">
          <Globe className="mt-0.5 h-4 w-4 shrink-0 text-subtle" aria-hidden />
          A fresh browser for every job: no cookies or logins kept, public websites only.
        </li>
      </ul>
      <section aria-labelledby="jobs-heading" className="space-y-3">
        <h2 id="jobs-heading" className="font-semibold">
          Your jobs
        </h2>
        <QueryState query={jobs} loading={<SkeletonRows rows={3} />}>
          {(list: Job[]) =>
            list.length ? (
              <div className="space-y-3">
                {list.map((j) => (
                  <JobCard key={j.run_id} job={j} />
                ))}
              </div>
            ) : (
              <EmptyState title="No jobs yet" description="Try one of the examples above. The assistant can also look things up on the web when you ask it." />
            )
          }
        </QueryState>
      </section>
    </div>
  );
}
