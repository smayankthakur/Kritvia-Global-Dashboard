"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { DeleteProposalButton } from "@/components/leads/delete-proposal";
import { StatusBadge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatDate, formatINR } from "@/lib/format";
import { PAGE_SIZE, flatPages, unwrapPage } from "@/lib/paging";
import { useVenture } from "@/lib/venture";

function ProposalsView() {
  const v = useVenture();
  const lead = useSearchParams().get("lead");
  // 200 at a time; "Load more" follows the API's cursor (round 3, B13).
  const q = useInfiniteQuery({
    queryKey: ["proposals", v.id, lead],
    queryFn: ({ pageParam }) =>
      unwrapPage(
        api.GET("/ventures/{venture_id}/proposals", {
          params: { path: { venture_id: v.id }, query: { lead_id: lead ?? undefined, limit: PAGE_SIZE, cursor: pageParam ?? undefined } },
        }),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
  });
  const data = flatPages(q.data?.pages);
  return (
    <>
      <PageHeader
        eyebrow={v.venture_name}
        title="Proposals"
        description="Drafted from the rate card and cited past work. Sent only after your approval; mark the client's decision to improve future pricing."
        actions={lead ? <ButtonLink href={`/v/${v.id}/proposals`}>Show all</ButtonLink> : undefined}
      />
      <Card>
        {q.isPending ? (
          <SkeletonRows rows={5} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : data.length === 0 ? (
          <EmptyState icon={FileText} title="No proposals yet" description="Proposals appear when lead triage drafts one, or when you start one from a lead." />
        ) : (
          <>
            <Table label="Proposals">
              <THead>
                <tr>
                  <Th>Proposal</Th>
                  <Th className="hidden sm:table-cell">Lead</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Total (incl. GST)</Th>
                  <Th className="hidden md:table-cell">Created</Th>
                  <Th>
                    <span className="sr-only">Delete</span>
                  </Th>
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
                    <Td className="text-right">
                      <DeleteProposalButton ventureId={v.id} proposal={p} iconOnly />
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
            {q.hasNextPage ? (
              <div className="flex justify-center border-t border-border p-3">
                <Button loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
                  Load more
                </Button>
              </div>
            ) : null}
          </>
        )}
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
