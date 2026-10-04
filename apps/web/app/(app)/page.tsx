"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Building2 } from "lucide-react";
import Link from "next/link";
import { RetryRunButton, workflowLabel } from "@/components/runs/run-actions";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page";
import { Stat, StatGrid } from "@/components/ui/stat";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/states";
import { ApiError, api, unwrap, type Schemas } from "@/lib/api";
import { kindOf, useAccess } from "@/lib/access";
import { formatHours, formatINR, formatNumber, formatPercent, formatRelative, formatDate } from "@/lib/format";
import { KIND_LABEL, ventureNav } from "@/lib/nav";

type VCard = Schemas["VentureCard"];

const RUN_ORDER: [string, string][] = [
  ["completed", "bg-success"],
  ["running", "bg-info"],
  ["queued", "bg-border-strong"],
  ["waiting", "bg-warning"],
  ["failed", "bg-danger"],
  ["cancelled", "bg-surface-3"],
];

function RunsBar({ runs }: { runs: Record<string, number> }) {
  const total = Object.values(runs).reduce((a, b) => a + b, 0);
  if (!total) return <p className="text-xs text-subtle">No runs in the last 7 days</p>;
  return (
    <div>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-3" role="img" aria-label={`Runs by status: ${Object.entries(runs).map(([k, v]) => `${v} ${k}`).join(", ")}`}>
        {RUN_ORDER.filter(([k]) => runs[k]).map(([k, cls]) => (
          <div key={k} className={cls} style={{ width: `${((runs[k] ?? 0) / total) * 100}%` }} />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
        {RUN_ORDER.filter(([k]) => runs[k]).map(([k, cls]) => (
          <li key={k} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${cls}`} aria-hidden />
            {runs[k]} {k}
          </li>
        ))}
      </ul>
    </div>
  );
}

function statusCounts(obj: unknown): [string, number][] {
  if (!obj || typeof obj !== "object") return [];
  return Object.entries(obj as Record<string, number>).filter(([, v]) => typeof v === "number");
}

function KindMetrics({ card }: { card: VCard }) {
  const m = card.metrics as Record<string, unknown>;
  const kind = kindOf(card);
  const blocks: React.ReactNode[] = [];
  if ((kind === "software" || kind === "general") && "hot_leads" in m) {
    blocks.push(
      <StatGrid key="sw" className="sm:grid-cols-2">
        <Stat label="Hot leads (open)" value={formatNumber(m.hot_leads as number)} />
        <Stat label="Median inquiry → approved proposal" value={formatHours(m.median_hours_inquiry_to_approved_proposal as number | null)} />
      </StatGrid>,
    );
    const leads = statusCounts(m.leads);
    if (leads.length)
      blocks.push(
        <div key="leads" className="flex flex-wrap gap-1.5">
          {leads.map(([k, v]) => (
            <Badge key={k}>
              {k} · {v}
            </Badge>
          ))}
        </div>,
      );
  }
  if ((kind === "finance" || kind === "general") && "loan_applications" in m) {
    const apps = statusCounts(m.loan_applications);
    blocks.push(
      <div key="fin">
        <p className="mb-1.5 text-xs font-medium text-subtle">Loan applications</p>
        {apps.length ? (
          <div className="flex flex-wrap gap-1.5">
            {apps.map(([k, v]) => (
              <Badge key={k}>
                {k.replace(/_/g, " ")} · {v}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-xs text-subtle">None yet</p>
        )}
      </div>,
    );
  }
  if ((kind === "kitchen" || kind === "general") && "mape_14d" in m) {
    const lf = m.latest_forecast as { target_date: string; portions: number } | null;
    blocks.push(
      <StatGrid key="kit" className="sm:grid-cols-3">
        <Stat label="Latest forecast" value={lf ? `${formatNumber(lf.portions, 0)} portions` : "—"} hint={lf ? formatDate(lf.target_date) : "No plan yet"} />
        <Stat label="Forecast error (14d MAPE)" value={m.mape_14d === null ? "—" : `${m.mape_14d}%`} />
        <Stat label="POs sent (7d)" value={formatINR(m.po_value_7d as number, { whole: true })} />
      </StatGrid>,
    );
  }
  return <div className="space-y-4">{blocks}</div>;
}

function VentureCardView({ card }: { card: VCard }) {
  const mc = card.model_calls_7d as Record<string, number>;
  const tokens = (mc.prompt_tokens ?? 0) + (mc.completion_tokens ?? 0);
  const firstPage = ventureNav(card.venture_id, kindOf(card)).domain[0]?.href ?? `/v/${card.venture_id}/runs`;
  const runsTotal = Object.values(card.runs_7d).reduce((a, b) => a + b, 0);
  return (
    <Card className="flex flex-col">
      <CardHeader
        title={
          <Link href={firstPage} className="hover:text-accent">
            {card.name}
          </Link>
        }
        description={KIND_LABEL[kindOf(card)]}
        actions={
          card.pending_approvals ? (
            <Link href="/inbox">
              <Badge tone="warning" dot>
                {card.pending_approvals} awaiting approval
              </Badge>
            </Link>
          ) : (
            <Badge tone="success" dot>
              Inbox clear
            </Badge>
          )
        }
      />
      <div className="flex-1 space-y-5 p-4">
        <StatGrid>
          <Stat
            label="Pending approvals"
            value={card.pending_approvals}
            hint={card.oldest_pending_hours ? `oldest ${formatHours(card.oldest_pending_hours)}` : "none waiting"}
            tone={card.oldest_pending_hours && card.oldest_pending_hours > 24 ? "warning" : undefined}
          />
          <Stat label="Runs (7d)" value={runsTotal} />
          <Stat label="Approved without edit" value={formatPercent(card.approval_without_edit_rate)} hint="last 30 days" />
          <Stat
            label="Model calls (7d)"
            value={formatNumber(mc.calls ?? 0)}
            hint={`${formatNumber(tokens)} tokens${mc.rate_limited ? ` · ${mc.rate_limited} rate-limited` : ""}`}
          />
        </StatGrid>
        <RunsBar runs={card.runs_7d} />
        <KindMetrics card={card} />
      </div>
      {card.failed_recent.length ? (
        <div className="border-t border-border">
          <h3 className="flex items-center gap-1.5 px-4 pt-3 text-xs font-semibold text-danger">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> Recent failures
          </h3>
          <ul className="divide-y divide-border">
            {card.failed_recent.map((f) => {
              const run = f as { id: string; workflow: string; title: string; error: string | null; updated_at: string };
              return (
                <li key={run.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <Link href={`/v/${card.venture_id}/runs/${run.id}`} className="block truncate text-sm font-medium hover:text-accent">
                      {run.title || workflowLabel(run.workflow)}
                    </Link>
                    <p className="truncate text-xs text-subtle" title={run.error ?? undefined}>
                      {workflowLabel(run.workflow)} · {formatRelative(run.updated_at)}
                      {run.error ? ` · ${run.error}` : ""}
                    </p>
                  </div>
                  <RetryRunButton ventureId={card.venture_id} runId={run.id} />
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

export default function DashboardPage() {
  const { org, me } = useAccess();
  const q = useQuery({
    queryKey: ["dashboard", org?.id],
    queryFn: () => unwrap(api.GET("/orgs/{org_id}/dashboard", { params: { path: { org_id: org!.id } } })),
    enabled: Boolean(org),
    refetchInterval: 60_000,
  });
  const hello = me?.full_name?.split(" ")[0];

  return (
    <>
      <PageHeader
        eyebrow={org?.name}
        title={hello ? `Good to see you, ${hello}` : "Executive dashboard"}
        description="Every venture at a glance: what agents did this week and what is waiting on you."
        actions={
          <ButtonLink href="/inbox" variant="primary" icon={<ArrowRight className="h-4 w-4" />}>
            Open inbox
          </ButtonLink>
        }
      />
      {q.isPending ? (
        <div className="space-y-4">
          <Skeleton className="h-20" />
          <div className="grid gap-4 xl:grid-cols-2">
            <Skeleton className="h-80" />
            <Skeleton className="h-80" />
          </div>
        </div>
      ) : q.isError ? (
        q.error instanceof ApiError && q.error.status === 404 ? (
          <Card>
            <EmptyState
              icon={Building2}
              title="No ventures yet"
              description="Add your first venture to start running agents."
              action={<ButtonLink href="/onboarding" variant="primary">Set up ventures</ButtonLink>}
            />
          </Card>
        ) : (
          <Card>
            <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          </Card>
        )
      ) : (
        <div className="space-y-6">
          <Card className="p-4 sm:p-5">
            <StatGrid>
              <Stat label="Pending approvals" value={formatNumber(q.data.totals.pending_approvals as number)} tone={(q.data.totals.pending_approvals as number) ? "warning" : undefined} />
              <Stat label="Recent failed runs" value={formatNumber(q.data.totals.failed_runs as number)} tone={(q.data.totals.failed_runs as number) ? "danger" : undefined} />
              <Stat label="Runs (7 days)" value={formatNumber(q.data.totals.runs_7d as number)} />
              <Stat label="Ventures" value={q.data.ventures.length} />
            </StatGrid>
          </Card>
          <div className="kv-stagger grid gap-4 xl:grid-cols-2">
            {q.data.ventures.map((c) => (
              <VentureCardView key={c.venture_id} card={c} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}
