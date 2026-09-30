"use client";

import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { StatusBadge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page";
import { EmptyState, QueryState } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { api, unwrap } from "@/lib/api";
import { formatDate, formatINR } from "@/lib/format";
import { useVenture } from "@/lib/venture";

function ProposalsView() {
  const v = useVenture();
  const lead = useSearchParams().get("lead");
  const q = useQuery({
    queryKey: ["proposals", v.id, lead],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/proposals", { params: { path: { venture_id: v.id }, query: { lead_id: lead ?? undefined } } })),
  });
  return (
    <>
      <PageHeader
        eyebrow={v.venture_name}
        title="Proposals"
        description="Drafted from the rate card and cited past work. Sent only after your approval; mark the client's decision to improve future pricing."
        actions={lead ? <ButtonLink href={`/v/${v.id}/proposals`}>Show all</ButtonLink> : undefined}
      />
      <Card>
        <QueryState query={q} empty={<EmptyState icon={FileText} title="No proposals yet" description="Proposals appear when lead triage drafts one." />}>
          {(data) => (
            <Table label="Proposals">
              <THead>
                <tr>
                  <Th>Proposal</Th>
                  <Th className="hidden sm:table-cell">Lead</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Total (incl. GST)</Th>
                  <Th className="hidden md:table-cell">Created</Th>
                </tr>
              </THead>
              <TBody>
                {data.map((p) => (
                  <Tr key={p.id}>
                    <Td className="max-w-[20rem]">
                      <Link href={`/v/${v.id}/proposals/${p.id}`} className="block truncate font-medium hover:text-accent">
                        {p.title}
                      </Link>
                      <span className="text-xs text-subtle">{p.line_items.length} line item(s)</span>
                    </Td>
                    <Td className="hidden text-muted sm:table-cell">{p.lead_name ?? "—"}</Td>
                    <Td>
                      <StatusBadge status={p.status} />
                    </Td>
                    <Td className="text-right font-medium whitespace-nowrap tabular-nums">{formatINR(p.total_inr)}</Td>
                    <Td className="hidden whitespace-nowrap text-muted md:table-cell">{formatDate(p.created_at)}</Td>
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

export default function ProposalsPage() {
  return (
    <Suspense>
      <ProposalsView />
    </Suspense>
  );
}
