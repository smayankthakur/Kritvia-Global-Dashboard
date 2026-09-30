"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ListChecks, RotateCcw, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page";
import { EmptyState, QueryState } from "@/components/ui/states";
import { Tabs } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { api, enumValues, errorMessage, unwrap, type Paths } from "@/lib/api";
import { formatDate, formatTimestamp } from "@/lib/format";
import { useVenture } from "@/lib/venture";

type Query = NonNullable<Paths["/ventures/{venture_id}/facts"]["get"]["parameters"]["query"]>;
type Kind = NonNullable<Query["kind"]>;
type Status = NonNullable<Query["status"]>;
const STATUSES = enumValues<Status>()("open", "done", "dropped");

function TasksView() {
  const v = useVenture();
  const params = useSearchParams();
  const router = useRouter();
  const kind: Kind = params.get("kind") === "decision" ? "decision" : "task";
  const rawStatus = params.get("status");
  const status: Status | null = rawStatus === "all" ? null : STATUSES.includes(rawStatus as Status) ? (rawStatus as Status) : kind === "task" ? "open" : null;
  const documentId = params.get("document");
  const qc = useQueryClient();
  const toast = useToast();

  const setParam = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, val] of Object.entries(patch)) {
      if (val === null || val === "") p.delete(k);
      else p.set(k, val);
    }
    router.replace(`/v/${v.id}/tasks${p.size ? `?${p}` : ""}`, { scroll: false });
  };

  const facts = useQuery({
    queryKey: ["facts", v.id, kind, status, documentId],
    queryFn: () =>
      unwrap(
        api.GET("/ventures/{venture_id}/facts", {
          params: {
            path: { venture_id: v.id },
            query: { kind, status: kind === "task" && status ? status : undefined, document_id: documentId ?? undefined, limit: 300 },
          },
        }),
      ),
  });
  const patch = useMutation({
    mutationFn: ({ id, s }: { id: string; s: Status }) =>
      unwrap(api.PATCH("/ventures/{venture_id}/facts/{fact_id}", { params: { path: { venture_id: v.id, fact_id: id } }, body: { status: s } })),
    onSuccess: (f) => {
      toast.success(`Task marked ${f.status}`);
      void qc.invalidateQueries({ queryKey: ["facts", v.id] });
    },
    onError: (e) => toast.error("Could not update task", errorMessage(e)),
  });

  return (
    <>
      <PageHeader
        eyebrow={v.venture_name}
        title="Tasks & decisions"
        description="Extracted from meetings, emails and documents — each one links to the exact passage or timestamp it came from."
        actions={documentId ? <ButtonLink href={`/v/${v.id}/tasks?kind=${kind}`}>Show all sources</ButtonLink> : undefined}
      />
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <Tabs
          label="Kind"
          value={kind}
          onChange={(k) => setParam({ kind: k === "task" ? null : k, status: null })}
          items={[
            { id: "task", label: "Tasks" },
            { id: "decision", label: "Decisions" },
          ]}
          className="border-b-0"
        />
        {kind === "task" ? (
          <div className="w-40">
            <label htmlFor="task-status" className="sr-only">
              Status
            </label>
            <Select id="task-status" value={status ?? "all"} onChange={(e) => setParam({ status: e.target.value === "open" ? null : e.target.value })}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s === "open" ? "Open" : s === "done" ? "Done" : "Dropped"}
                </option>
              ))}
              <option value="all">All</option>
            </Select>
          </div>
        ) : null}
      </div>
      <Card>
        <QueryState
          query={facts}
          empty={
            <EmptyState
              icon={ListChecks}
              title={kind === "task" ? "No tasks here" : "No decisions recorded"}
              description="Upload a meeting recording or add notes — owners, due dates and decisions are extracted automatically."
            />
          }
        >
          {(data) => (
            <ul className="divide-y divide-border">
              {data.map((f) => (
                <li key={f.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className={`text-sm ${f.status === "done" ? "text-subtle line-through" : ""}`}>{f.statement}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
                      {f.owner ? <Badge tone="info">{f.owner}</Badge> : null}
                      {f.due_date ? <span>due {formatDate(f.due_date)}</span> : null}
                      {f.subject ? <span>re {f.subject}</span> : null}
                      <Link href={`/v/${v.id}/knowledge/${f.document_id}?chunk=${f.chunk_id}`} className="text-accent hover:underline">
                        {f.document_title}
                        {f.source_start_s !== null ? ` @ ${formatTimestamp(f.source_start_s)}` : ""}
                      </Link>
                    </p>
                  </div>
                  {kind === "task" ? (
                    <div className="flex shrink-0 items-center gap-1.5">
                      {f.status ? <StatusBadge status={f.status} /> : null}
                      {f.status !== "done" ? (
                        <Button size="sm" icon={<Check className="h-3.5 w-3.5" />} onClick={() => patch.mutate({ id: f.id, s: "done" })} disabled={patch.isPending}>
                          Done
                        </Button>
                      ) : null}
                      {f.status === "open" || !f.status ? (
                        <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} onClick={() => patch.mutate({ id: f.id, s: "dropped" })} disabled={patch.isPending}>
                          Drop
                        </Button>
                      ) : (
                        <Button size="sm" variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => patch.mutate({ id: f.id, s: "open" })} disabled={patch.isPending}>
                          Reopen
                        </Button>
                      )}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </Card>
    </>
  );
}

export default function TasksPage() {
  return (
    <Suspense>
      <TasksView />
    </Suspense>
  );
}
