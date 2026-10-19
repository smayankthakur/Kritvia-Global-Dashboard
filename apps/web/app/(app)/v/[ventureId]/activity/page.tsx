"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, X } from "lucide-react";
import { useState } from "react";
import { rupees, toPaise } from "@/components/invoices/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, FormError, Input, Select } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page";
import { EmptyState, QueryState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useVenture } from "@/lib/venture";

const GROUP_TONE: Record<string, "success" | "info" | "warning" | "neutral" | "danger"> = {
  invoice: "success",
  payment: "success",
  lead: "info",
  booking: "info",
  bill: "warning",
  review: "neutral",
  customer: "danger",
  campaign: "neutral",
  candidate: "info",
};

function Alerts({ ventureId, kinds, canAdmin }: { ventureId: string; kinds: Schemas["EventKindOut"][]; canAdmin: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState("invoice.paid");
  const [min, setMin] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const key = ["event-alerts", ventureId];
  const q = useQuery({ queryKey: key, queryFn: () => unwrap(api.GET("/ventures/{venture_id}/event-alerts", { params: { path: { venture_id: ventureId } } })) });
  const money = kinds.find((k) => k.kind === kind)?.has_amount;
  const add = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/ventures/{venture_id}/event-alerts", {
          params: { path: { venture_id: ventureId } },
          body: { kind, min_paise: money && min.trim() ? toPaise(min) : null },
        }),
      ),
    onSuccess: () => {
      toast.success("Alert set up");
      setMin("");
      setErr(null);
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => setErr(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/ventures/{venture_id}/event-alerts/{alert_id}", { params: { path: { venture_id: ventureId, alert_id: id } } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  });
  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <BellRing className="h-4 w-4 text-subtle" aria-hidden /> Tell me when…
          </span>
        }
        description="The owners and admins get a push, Telegram or email within a minute."
      />
      <CardBody className="space-y-3">
        {(q.data ?? []).length ? (
          <ul className="space-y-1 text-sm">
            {(q.data ?? []).map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2">
                <span>
                  {a.words}
                  {a.min_paise ? ` (${rupees(a.min_paise)} or more)` : ""}
                </span>
                {canAdmin ? (
                  <Button size="icon" variant="ghost" aria-label={`Stop: ${a.words}`} onClick={() => remove.mutate(a.id)}>
                    <X className="h-4 w-4" />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-subtle">No alerts yet.</p>
        )}
        {canAdmin ? (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="When" className="min-w-56">
              <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                {kinds.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {k.words}
                  </option>
                ))}
              </Select>
            </Field>
            {money ? (
              <Field label="Only from (₹, optional)" className="w-40">
                <Input value={min} onChange={(e) => setMin(e.target.value)} inputMode="decimal" placeholder="e.g. 25000" />
              </Field>
            ) : null}
            <Button variant="primary" loading={add.isPending} onClick={() => add.mutate()}>
              Add
            </Button>
          </div>
        ) : null}
        <FormError message={err} />
      </CardBody>
    </Card>
  );
}

export default function ActivityPage() {
  const v = useVenture();
  const [kind, setKind] = useState("");
  const kinds = useQuery({
    queryKey: ["event-kinds", v.id],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/events/kinds", { params: { path: { venture_id: v.id } } })),
    staleTime: Infinity,
  });
  const q = useQuery({
    queryKey: ["events", v.id, kind],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/events", { params: { path: { venture_id: v.id }, query: { kind: kind || undefined, limit: 200 } } })),
    refetchInterval: 30_000,
  });
  const canAdmin = Boolean(v.can_admin || v.is_owner);
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={v.venture_name}
        title="Activity"
        description="Everything that happens in the business, as it happens. Agents and your skills react to it within a minute, and you can be told about what matters to you."
      />
      {kinds.data ? <Alerts ventureId={v.id} kinds={kinds.data} canAdmin={canAdmin} /> : null}
      <div className="flex justify-end">
        <Field label="Show" className="w-64">
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Everything</option>
            {(kinds.data ?? []).map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.words}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Card className="overflow-hidden p-0">
        <QueryState query={q} loading={<SkeletonRows rows={6} className="p-3" />}>
          {(d: Schemas["BusinessEventOut"][]) =>
            d.length ? (
              <ul className="divide-y divide-border" aria-label="Activity">
                {d.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                    <Badge tone={GROUP_TONE[e.kind.split(".")[0] ?? ""] ?? "neutral"}>{e.what}</Badge>
                    <span className="min-w-0 flex-1">{e.summary}</span>
                    <span className="text-xs text-subtle">{formatDateTime(e.occurred_at)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="Nothing yet" description="Leads, invoices, payments, bookings, bills and reviews appear here as they happen." />
            )
          }
        </QueryState>
      </Card>
    </div>
  );
}
