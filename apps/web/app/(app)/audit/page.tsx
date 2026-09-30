"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { ScrollText, ShieldCheck, ShieldX } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/field";
import { Notice, PageHeader } from "@/components/ui/page";
import { EmptyState, QueryState } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { api, errorMessage, unwrap } from "@/lib/api";
import { useAccess } from "@/lib/access";
import { formatDateTime } from "@/lib/format";

function Details({ d }: { d: Record<string, unknown> }) {
  const entries = Object.entries(d);
  if (!entries.length) return <span className="text-subtle">—</span>;
  return (
    <span className="block max-w-[28rem] truncate font-mono text-xs text-muted" title={JSON.stringify(d)}>
      {entries.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : typeof v === "object" ? JSON.stringify(v) : String(v)}`).join("  ")}
    </span>
  );
}

export default function AuditPage() {
  const { org, ventures, isOwner } = useAccess();
  const [venture, setVenture] = useState("");
  const [limit, setLimit] = useState(100);
  const q = useQuery({
    queryKey: ["audit", org?.id, venture, limit],
    queryFn: () => unwrap(api.GET("/orgs/{org_id}/audit", { params: { path: { org_id: org!.id }, query: { venture_id: venture || undefined, limit } } })),
    enabled: Boolean(org),
  });
  const verify = useMutation({ mutationFn: () => unwrap(api.GET("/orgs/{org_id}/audit/verify", { params: { path: { org_id: org!.id } } })) });
  const vName = (id: string | null) => (id ? (ventures.find((v) => v.venture_id === id)?.venture_name ?? id.slice(0, 8)) : "org");

  return (
    <>
      <PageHeader
        eyebrow={org?.name}
        title="Audit log"
        description="Every write, download, decision and export, in a per-organisation SHA-256 hash chain that the application cannot rewrite."
        actions={
          <Button variant="primary" icon={<ShieldCheck className="h-4 w-4" />} loading={verify.isPending} onClick={() => verify.mutate()} disabled={!isOwner}>
            Verify chain
          </Button>
        }
      />
      {verify.data ? (
        verify.data.intact ? (
          <Notice tone="success" title="Chain intact" className="mb-4">
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4" aria-hidden /> Every entry&apos;s hash matches its predecessor — nothing has been altered or removed.
            </span>
          </Notice>
        ) : (
          <Notice tone="danger" title="Chain broken" className="mb-4">
            <span className="flex items-center gap-1.5">
              <ShieldX className="h-4 w-4" aria-hidden /> The first mismatch is at sequence {verify.data.first_broken_seq}. Treat this as a security incident.
            </span>
          </Notice>
        )
      ) : verify.isError ? (
        <Notice tone="danger" className="mb-4">
          {errorMessage(verify.error)}
        </Notice>
      ) : null}
      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-border p-3">
          <div className="w-52">
            <label htmlFor="audit-venture" className="mb-1 block text-xs font-medium text-subtle">
              Venture
            </label>
            <Select id="audit-venture" value={venture} onChange={(e) => setVenture(e.target.value)}>
              <option value="">All ventures</option>
              {ventures.map((v) => (
                <option key={v.venture_id} value={v.venture_id}>
                  {v.venture_name}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-32">
            <label htmlFor="audit-limit" className="mb-1 block text-xs font-medium text-subtle">
              Show
            </label>
            <Select id="audit-limit" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
              {[50, 100, 250, 500].map((n) => (
                <option key={n} value={n}>
                  {n} entries
                </option>
              ))}
            </Select>
          </div>
        </div>
        <QueryState query={q} empty={<EmptyState icon={ScrollText} title="No audit entries" />}>
          {(data) => (
            <Table label="Audit log">
              <THead>
                <tr>
                  <Th className="text-right">Seq</Th>
                  <Th>Time</Th>
                  <Th>Actor</Th>
                  <Th>Action</Th>
                  <Th className="hidden md:table-cell">Entity</Th>
                  <Th className="hidden lg:table-cell">Details</Th>
                </tr>
              </THead>
              <TBody>
                {data.map((a) => (
                  <Tr key={a.seq}>
                    <Td className="text-right font-mono text-xs text-subtle tabular-nums">{a.seq}</Td>
                    <Td className="text-xs whitespace-nowrap text-muted">{formatDateTime(a.occurred_at)}</Td>
                    <Td>
                      <Badge tone={a.actor_type === "agent" ? "accent" : a.actor_type === "system" ? "neutral" : "info"}>{a.actor_type}</Badge>
                    </Td>
                    <Td>
                      <span className="font-mono text-xs">{a.action}</span>
                      <span className="block text-xs text-subtle">{vName(a.venture_id)}</span>
                    </Td>
                    <Td className="hidden md:table-cell">
                      <span className="font-mono text-xs text-muted">{a.entity_table ?? "—"}</span>
                      {a.entity_id ? <span className="block font-mono text-[11px] text-subtle">{a.entity_id.slice(0, 8)}</span> : null}
                    </Td>
                    <Td className="hidden lg:table-cell">
                      <Details d={a.details as Record<string, unknown>} />
                    </Td>
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
