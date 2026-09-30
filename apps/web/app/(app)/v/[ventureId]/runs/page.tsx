"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { RetryRunButton, workflowLabel } from "@/components/runs/run-actions";
import { StatusBadge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page";
import { EmptyState, QueryState } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { api, unwrap, type Paths } from "@/lib/api";
import { formatRelative, formatDateTime } from "@/lib/format";
import { useVenture } from "@/lib/venture";

type RunStatus = NonNullable<NonNullable<Paths["/ventures/{venture_id}/runs"]["get"]["parameters"]["query"]>["status"]>;
const STATUSES: RunStatus[] = ["queued", "running", "waiting", "completed", "failed", "cancelled"];

export default function RunsPage() {
  const v = useVenture();
  const [status, setStatus] = useState<RunStatus | "">("");
  const [workflow, setWorkflow] = useState("");
  const runs = useQuery({
    queryKey: ["runs", v.id, { status, workflow }],
    queryFn: () =>
      unwrap(
        api.GET("/ventures/{venture_id}/runs", {
          params: { path: { venture_id: v.id }, query: { status: status || undefined, workflow: workflow || undefined, limit: 100 } },
        }),
      ),
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === "queued" || r.status === "running") ? 3000 : 30_000),
  });
  const catalogue = useQuery({ queryKey: ["workflows"], queryFn: () => unwrap(api.GET("/workflows")), staleTime: 10 * 60_000 });

  return (
    <>
      <PageHeader
        eyebrow={v.venture_name}
        title="Runs"
        description="Durable workflow runs. Each step is recorded; failed runs can be retried from the step that failed."
      />
      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-border p-3">
          <div className="w-44">
            <label htmlFor="run-status" className="mb-1 block text-xs font-medium text-subtle">
              Status
            </label>
            <Select id="run-status" value={status} onChange={(e) => setStatus(e.target.value as RunStatus | "")}>
              <option value="">All statuses</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-52">
            <label htmlFor="run-wf" className="mb-1 block text-xs font-medium text-subtle">
              Workflow
            </label>
            <Select id="run-wf" value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
              <option value="">All workflows</option>
              {(catalogue.data ?? []).map((w) => (
                <option key={w.name} value={w.name}>
                  {w.title}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <QueryState
          query={runs}
          empty={<EmptyState icon={Activity} title="No runs match" description="Runs appear when a workflow starts — from an inquiry, an upload, a schedule or a webhook." />}
        >
          {(data) => (
            <Table label="Runs">
              <THead>
                <tr>
                  <Th>Run</Th>
                  <Th>Status</Th>
                  <Th className="hidden md:table-cell">Step</Th>
                  <Th className="hidden sm:table-cell">Trigger</Th>
                  <Th className="hidden sm:table-cell">Updated</Th>
                  <Th className="text-right">
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </THead>
              <TBody>
                {data.map((r) => (
                  <Tr key={r.id}>
                    <Td className="max-w-[18rem]">
                      <Link href={`/v/${v.id}/runs/${r.id}`} className="block truncate font-medium hover:text-accent">
                        {r.title || workflowLabel(r.workflow)}
                      </Link>
                      <span className="block truncate text-xs text-subtle">
                        {workflowLabel(r.workflow)}
                        {r.error ? ` · ${r.error}` : ""}
                      </span>
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1.5">
                        <StatusBadge status={r.status} />
                        {r.pending_approvals ? <span className="text-xs text-warning">{r.pending_approvals} to approve</span> : null}
                      </div>
                    </Td>
                    <Td className="hidden text-muted md:table-cell">{r.current_step}</Td>
                    <Td className="hidden text-muted sm:table-cell">{r.trigger_kind}</Td>
                    <Td className="hidden whitespace-nowrap text-muted sm:table-cell" title={formatDateTime(r.updated_at)}>
                      {formatRelative(r.updated_at)}
                    </Td>
                    <Td className="text-right">{r.status === "failed" ? <RetryRunButton ventureId={v.id} runId={r.id} /> : null}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </QueryState>
      </Card>
    </>
  );
}
