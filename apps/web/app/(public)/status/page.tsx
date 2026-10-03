"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, XCircle } from "lucide-react";
import { PublicShell } from "@/components/public/doc-page";

interface StatusOut {
  app: string;
  api: "operational" | "degraded" | "down";
  latency_ms: number | null;
  checked_at: string;
}

const ROW: Record<string, { icon: typeof CheckCircle2; cls: string; text: string }> = {
  operational: { icon: CheckCircle2, cls: "text-success", text: "Operational" },
  degraded: { icon: CircleAlert, cls: "text-warning", text: "Degraded" },
  down: { icon: XCircle, cls: "text-danger", text: "Not responding" },
};

function Row({ name, state }: { name: string; state: string }) {
  const r = ROW[state] ?? ROW.down!;
  const Icon = r.icon;
  return (
    <li className="flex items-center justify-between px-4 py-3">
      <span className="font-medium">{name}</span>
      <span className={`flex items-center gap-1.5 text-sm ${r.cls}`}>
        <Icon className="h-4 w-4" aria-hidden />
        {r.text}
      </span>
    </li>
  );
}

export default function StatusPage() {
  const q = useQuery({
    queryKey: ["public-status"],
    queryFn: async () => (await (await fetch("/api/status", { cache: "no-store" })).json()) as StatusOut,
    refetchInterval: 30_000,
  });
  const all = q.data && q.data.api === "operational";
  return (
    <PublicShell>
      <h1 className="text-2xl font-semibold tracking-tight">Kritvia status</h1>
      <div className={`mt-6 rounded-lg border p-4 text-base font-medium ${q.isPending ? "border-border" : all ? "border-success/40 bg-success/10" : "border-warning/40 bg-warning/10"}`} role="status">
        {q.isPending ? "Checking…" : all ? "All systems operational" : "Some systems are having problems. We are on it."}
      </div>
      <ul className="mt-4 divide-y divide-border rounded-lg border border-border bg-surface">
        <Row name="Web app" state={q.data?.app ?? "operational"} />
        <Row name="API, agents and database" state={q.data?.api ?? (q.isError ? "down" : "operational")} />
      </ul>
      <p className="mt-3 text-xs text-subtle">
        Checked {q.data ? new Date(q.data.checked_at).toLocaleTimeString("en-IN") : "—"}
        {q.data?.latency_ms ? ` · ${q.data.latency_ms} ms` : ""} · refreshes every 30 seconds. Kritvia checks itself every 5 minutes and
        alerts the team on any failure.
      </p>
      <h2 className="mt-10 text-lg font-semibold">Past incidents</h2>
      <p className="mt-2 text-sm text-muted">No incidents reported.</p>
    </PublicShell>
  );
}
