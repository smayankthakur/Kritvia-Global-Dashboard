"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, FileText, X } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Markdown } from "@/components/ui/markdown";
import { KeyValue, PageHeader } from "@/components/ui/page";
import { ErrorState, Skeleton } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap } from "@/lib/api";
import { formatDateTime, formatINR, formatNumber } from "@/lib/format";
import { useVenture } from "@/lib/venture";

interface Line {
  code?: string;
  name?: string;
  unit?: string;
  qty?: string | number;
  rate?: string | number;
  amount?: string | number;
  note?: string;
}

export default function ProposalDetailPage() {
  const v = useVenture();
  const { proposalId } = useParams<{ proposalId: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ["proposals", v.id, "detail", proposalId],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/proposals/{proposal_id}", { params: { path: { venture_id: v.id, proposal_id: proposalId } } })),
  });
  const outcome = useMutation({
    mutationFn: (status: "accepted" | "rejected") =>
      unwrap(api.POST("/ventures/{venture_id}/proposals/{proposal_id}/outcome", { params: { path: { venture_id: v.id, proposal_id: proposalId } }, body: { status } })),
    onSuccess: (p) => {
      toast.success(`Marked ${p.status}`, p.status === "accepted" ? "The lead is now won." : "The lead is marked lost.");
      qc.setQueryData(["proposals", v.id, "detail", proposalId], p);
      void qc.invalidateQueries({ queryKey: ["proposals", v.id] });
      void qc.invalidateQueries({ queryKey: ["leads", v.id] });
    },
    onError: (e) => toast.error("Could not record outcome", errorMessage(e)),
  });

  if (q.isPending) return <Skeleton className="h-96" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const p = q.data;
  const lines = p.line_items as Line[];
  const ref = p.reference as { count?: number; min?: string; max?: string };
  const cites = p.citations as { document_id?: string; title?: string }[];

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href={`/v/${v.id}/proposals`} className="hover:text-accent">
            ← Proposals
          </Link>
        }
        title={p.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={p.status} /> for {p.lead_name ?? "unknown lead"} · created {formatDateTime(p.created_at)}
            {p.sent_at ? ` · sent ${formatDateTime(p.sent_at)}` : ""}
          </span>
        }
        actions={
          p.status === "sent" ? (
            <>
              <Button variant="primary" icon={<Check className="h-4 w-4" />} loading={outcome.isPending && outcome.variables === "accepted"} onClick={() => outcome.mutate("accepted")}>
                Mark accepted
              </Button>
              <Button icon={<X className="h-4 w-4" />} loading={outcome.isPending && outcome.variables === "rejected"} onClick={() => outcome.mutate("rejected")}>
                Mark rejected
              </Button>
            </>
          ) : undefined
        }
      />
      <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader title="Pricing" description="Computed from the rate card — never by the model." />
            <Table label="Line items">
              <THead>
                <tr>
                  <Th>Item</Th>
                  <Th className="text-right">Qty</Th>
                  <Th className="hidden text-right sm:table-cell">Rate</Th>
                  <Th className="text-right">Amount</Th>
                </tr>
              </THead>
              <TBody>
                {lines.map((l, i) => (
                  <Tr key={`${l.code}-${i}`}>
                    <Td>
                      <span className="font-medium">{l.name ?? l.code}</span>
                      {l.note ? <span className="block text-xs text-subtle">{l.note}</span> : null}
                    </Td>
                    <Td className="text-right whitespace-nowrap tabular-nums">
                      {formatNumber(l.qty ?? 0)} {l.unit}
                    </Td>
                    <Td className="hidden text-right whitespace-nowrap tabular-nums sm:table-cell">{formatINR(l.rate)}</Td>
                    <Td className="text-right whitespace-nowrap tabular-nums">{formatINR(l.amount)}</Td>
                  </Tr>
                ))}
                {(
                  [
                    ["Subtotal", p.subtotal_inr, false],
                    ["GST", p.gst_inr, false],
                    ["Total", p.total_inr, true],
                  ] as const
                ).map(([label, value, strong]) => (
                  <Tr key={label}>
                    <Td colSpan={3} className={strong ? "text-right font-semibold" : "text-right text-muted"}>
                      {label}
                    </Td>
                    <Td className={`text-right whitespace-nowrap tabular-nums ${strong ? "font-semibold" : ""}`}>{formatINR(value)}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </Card>
          <Card>
            <CardHeader title="Proposal" />
            <div className="p-4 sm:p-6">{p.content ? <Markdown>{p.content}</Markdown> : <p className="text-sm text-subtle">No content.</p>}</div>
          </Card>
        </div>
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader title="Sources cited" />
            {cites.length ? (
              <ul className="divide-y divide-border">
                {cites.map((c, i) => (
                  <li key={`${c.document_id}-${i}`} className="px-4 py-2.5">
                    <Link href={`/v/${v.id}/knowledge/${c.document_id}`} className="flex items-center gap-2 text-sm hover:text-accent">
                      <span className="flex h-5 min-w-5 items-center justify-center rounded bg-accent-soft px-1 text-[11px] font-semibold text-accent-soft-fg">{i + 1}</span>
                      <FileText className="h-3.5 w-3.5 text-subtle" aria-hidden />
                      <span className="truncate">{c.title ?? "Document"}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-4 text-sm text-subtle">No past documents were cited.</p>
            )}
          </Card>
          <Card>
            <CardHeader title="Price reference" description="Similar past proposals" />
            <div className="p-4">
              {ref.count ? (
                <KeyValue
                  items={[
                    ["Similar projects", ref.count],
                    ["Lowest", formatINR(ref.min)],
                    ["Highest", formatINR(ref.max)],
                  ]}
                />
              ) : (
                <p className="text-sm text-subtle">No comparable proposals yet.</p>
              )}
            </div>
          </Card>
          {p.run_id ? (
            <Link href={`/v/${v.id}/runs/${p.run_id}`} className="block text-sm text-accent hover:underline">
              View the run that drafted this →
            </Link>
          ) : null}
        </div>
      </div>
    </>
  );
}
