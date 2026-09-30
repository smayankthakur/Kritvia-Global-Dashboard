"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Circle, CircleAlert, CircleDashed, Loader2, PauseCircle } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { CancelRunButton, RetryRunButton, workflowLabel } from "@/components/runs/run-actions";
import { StatusBadge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { KeyValue, Notice, PageHeader } from "@/components/ui/page";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/states";
import { api, unwrap, type Schemas } from "@/lib/api";
import { displayValue } from "@/lib/diff";
import { formatDateTime, formatDuration, formatRelative, titleCase } from "@/lib/format";
import { useVenture } from "@/lib/venture";

const ACTIVE = new Set(["queued", "running"]);

function StepIcon({ status }: { status: string }) {
  const cls = "h-4 w-4";
  if (status === "completed" || status === "ok" || status === "done") return <CheckCircle2 className={cn(cls, "text-success")} aria-hidden />;
  if (status === "failed" || status === "error") return <CircleAlert className={cn(cls, "text-danger")} aria-hidden />;
  if (status === "running") return <Loader2 className={cn(cls, "animate-spin text-info")} aria-hidden />;
  if (status === "waiting" || status === "interrupted") return <PauseCircle className={cn(cls, "text-warning")} aria-hidden />;
  if (status === "skipped") return <CircleDashed className={cn(cls, "text-subtle")} aria-hidden />;
  return <Circle className={cn(cls, "text-subtle")} aria-hidden />;
}

function SummaryValue({ k, v, ventureId }: { k: string; v: unknown; ventureId: string }) {
  const s = displayValue(v);
  if (k === "lead_id" && typeof v === "string") return <Link className="text-accent hover:underline" href={`/v/${ventureId}/leads?lead=${v}`}>Open lead</Link>;
  if (k === "transcript_document_id" && typeof v === "string")
    return <Link className="text-accent hover:underline" href={`/v/${ventureId}/knowledge/${v}`}>Open transcript</Link>;
  if (typeof v === "object" && v !== null) return <pre className="overflow-x-auto rounded bg-surface-2 p-2 font-mono text-xs">{s}</pre>;
  return <span className="font-mono text-[13px]">{s || "—"}</span>;
}

function Timeline({ steps }: { steps: Schemas["StepOut"][] }) {
  if (!steps.length) return <EmptyState title="No steps recorded yet" description="The run is queued and will start shortly." />;
  return (
    <ol className="relative space-y-0 p-4">
      {steps.map((s, i) => (
        <li key={`${s.step}-${i}`} className="relative flex gap-3 pb-5 last:pb-0">
          {i < steps.length - 1 ? <span className="absolute top-5 bottom-0 left-[7px] w-px bg-border" aria-hidden /> : null}
          <span className="relative mt-0.5 bg-surface">
            <StepIcon status={s.status} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-sm font-medium">{titleCase(s.step)}</span>
              {s.agent ? <span className="text-xs text-subtle">agent: {s.agent}</span> : null}
              <span className="text-xs text-subtle">· {s.status}</span>
              <span className="ml-auto text-xs whitespace-nowrap text-subtle tabular-nums" title={formatDateTime(s.created_at)}>
                {formatDuration(s.duration_ms)} · {formatRelative(s.created_at)}
              </span>
            </div>
            {s.note ? <p className="mt-0.5 text-sm text-muted">{s.note}</p> : null}
            {s.error ? (
              <pre className="mt-1.5 overflow-x-auto rounded-md border border-danger/25 bg-danger-soft px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap text-danger-fg">
                {s.error}
              </pre>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export default function RunDetailPage() {
  const v = useVenture();
  const { runId } = useParams<{ runId: string }>();
  const run = useQuery({
    queryKey: ["runs", v.id, "detail", runId],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/runs/{run_id}", { params: { path: { venture_id: v.id, run_id: runId } } })),
    refetchInterval: (q) => (q.state.data && ACTIVE.has(q.state.data.status) ? 3000 : false),
  });

  if (run.isPending)
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-64" />
      </div>
    );
  if (run.isError) return <ErrorState error={run.error} onRetry={() => void run.refetch()} />;
  const r = run.data;
  const summary = Object.entries(r.summary ?? {});

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href={`/v/${v.id}/runs`} className="hover:text-accent">
            ← Runs · {v.venture_name}
          </Link>
        }
        title={r.title || workflowLabel(r.workflow)}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={r.status} />
            <span>
              {workflowLabel(r.workflow)} · triggered by {r.trigger_kind} · started {formatDateTime(r.created_at)}
            </span>
            {ACTIVE.has(r.status) ? <span className="text-xs text-info">Live — refreshing every 3 s</span> : null}
          </span>
        }
        actions={
          <>
            {r.status === "failed" ? <RetryRunButton ventureId={v.id} runId={r.id} size="md" /> : null}
            {["queued", "running", "waiting"].includes(r.status) ? <CancelRunButton ventureId={v.id} runId={r.id} /> : null}
          </>
        }
      />
      {r.error ? (
        <Notice tone="danger" title="This run failed" className="mb-4">
          <span className="font-mono text-xs break-words">{r.error}</span>
        </Notice>
      ) : null}
      <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
        <Card>
          <CardHeader title="Timeline" description={`${r.steps.length} step${r.steps.length === 1 ? "" : "s"} · current: ${r.current_step}`} />
          <Timeline steps={r.steps} />
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Approvals" description={r.pending_approvals ? `${r.pending_approvals} waiting` : undefined} />
            {r.approvals.length ? (
              <ul className="divide-y divide-border">
                {r.approvals.map((a) => (
                  <li key={a.id} className="px-4 py-2.5">
                    <div className="flex items-start justify-between gap-2">
                      {a.status === "pending" ? (
                        <Link href={`/inbox?id=${a.id}`} className="text-sm font-medium hover:text-accent">
                          {a.title}
                        </Link>
                      ) : (
                        <span className="text-sm font-medium">{a.title}</span>
                      )}
                      <StatusBadge status={a.status} />
                    </div>
                    <p className="text-xs text-subtle">
                      {a.agent} · {a.action} · {a.decided_at ? `decided ${formatRelative(a.decided_at)}` : `drafted ${formatRelative(a.created_at)}`}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-4 text-sm text-subtle">No drafts from this run.</p>
            )}
          </Card>
          <Card>
            <CardHeader title="Summary" />
            <div className="p-4">
              {summary.length ? (
                <KeyValue items={summary.map(([k, val]) => [titleCase(k), <SummaryValue key={k} k={k} v={val} ventureId={v.id} />])} />
              ) : (
                <p className="text-sm text-subtle">Nothing summarised yet.</p>
              )}
              {r.outcome ? <p className="mt-3 text-xs text-subtle">Outcome: {r.outcome}</p> : null}
              {r.finished_at ? <p className="mt-1 text-xs text-subtle">Finished {formatDateTime(r.finished_at)}</p> : null}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
