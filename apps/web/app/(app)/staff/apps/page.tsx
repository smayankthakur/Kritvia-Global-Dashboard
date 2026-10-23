"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, FormError, Input } from "@/components/ui/field";
import { Notice, PageHeader } from "@/components/ui/page";
import { EmptyState, QueryState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatRelative } from "@/lib/format";

type A = Schemas["StaffApp"];
const TONE: Record<A["status"], Tone> = { pending: "warning", approved: "success", rejected: "danger", listed: "neutral" };

function Review({ a }: { a: A }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [hosts, setHosts] = useState(a.egress_hosts.join(", "));
  const [note, setNote] = useState(a.review_note ?? "");
  const [error, setError] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: (status: "approved" | "rejected" | "pending") =>
      unwrap(
        api.POST("/staff/apps/review", {
          body: {
            id: a.id,
            status,
            note: note.trim() || null,
            egress_hosts: hosts.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean),
            // the approval covers exactly the package shown here; if it changed meanwhile, the API refuses
            package_hash: a.package_hash ?? null,
          },
        }),
      ),
    onSuccess: (_d, status) => {
      toast.success(status === "approved" ? "Approved: every business can connect it now" : status === "rejected" ? "Rejected" : "Back to waiting");
      setError(null);
      void qc.invalidateQueries({ queryKey: ["staff", "apps"] });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{a.title}</p>
          <p className="text-xs text-subtle">
            {a.id} · {a.package} · sent by {a.submitted_by ?? "the registry"} · {formatRelative(a.updated_at)}
          </p>
          {a.pinned ? <p className="text-xs break-all text-subtle">Pinned release: {a.pinned}</p> : null}
        </div>
        <Badge tone={TONE[a.status]}>{a.status}</Badge>
      </div>
      {a.description ? <p className="text-sm whitespace-pre-wrap text-muted">{a.description}</p> : null}
      <p className="text-sm">
        {a.repo_url ? (
          <a href={a.repo_url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
            Read the code
          </a>
        ) : (
          "No repository given"
        )}
        {(a.env ?? []).length ? ` · settings it asks for: ${(a.env ?? []).map((e) => e.name).join(", ")}` : ""}
      </p>
      <Field label="Sites it may reach" hint="Comma-separated, e.g. api.example.com, *.example.com. Its package registry is added by itself. Nothing else is reachable.">
        <Input value={hosts} onChange={(e) => setHosts(e.target.value)} autoComplete="off" />
      </Field>
      <Field label="Note (the business sees it)">
        <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </Field>
      <FormError message={error} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" loading={decide.isPending && decide.variables === "approved"} onClick={() => decide.mutate("approved")}>
          Approve this version
        </Button>
        <Button size="sm" variant="secondary" loading={decide.isPending && decide.variables === "rejected"} onClick={() => decide.mutate("rejected")}>
          Reject
        </Button>
        {a.status !== "pending" ? (
          <Button size="sm" variant="ghost" onClick={() => decide.mutate("pending")}>
            Back to waiting
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

/** Kritvia's team: apps that run as packages, waiting for a review before any business can use them. */
export default function StaffAppsPage() {
  const q = useQuery({ queryKey: ["staff", "apps"], queryFn: () => unwrap(api.GET("/staff/apps")) });
  return (
    <div className="space-y-6">
      <PageHeader
        title="Apps to review"
        description="MCP servers sent in from GitHub or asked for from the registry. Approving runs that exact package version in the sandbox, with only the sites you list."
      />
      <Notice tone="warning">Read the code before approving. Approved apps run for every business that connects them (in gVisor, with their own container and no other network).</Notice>
      <QueryState query={q} loading={<SkeletonRows rows={3} />}>
        {(list: A[]) =>
          list.length ? (
            <div className="space-y-3">
              {list.map((a) => (
                <Review key={a.id} a={a} />
              ))}
            </div>
          ) : (
            <EmptyState title="Nothing to review" description="Apps people send in appear here." />
          )
        }
      </QueryState>
    </div>
  );
}
