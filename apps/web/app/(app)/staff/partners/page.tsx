"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { rupees } from "@/components/invoices/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page";
import { QueryState, SkeletonRows } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatDate } from "@/lib/format";

type P = Schemas["StaffPartner"];

/** Kritvia's team: partner applications, approvals and payouts. */
export default function StaffPartnersPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["staff", "partners"] as const;
  const q = useQuery({ queryKey: key, queryFn: () => unwrap(api.GET("/staff/partners")) });
  const [paying, setPaying] = useState<P | null>(null);
  const [ref, setRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "active" | "paused" | "rejected" }) =>
      unwrap(api.POST("/staff/partners/{partner_id}/status", { params: { path: { partner_id: id } }, body: { status } })),
    onSuccess: (d) => qc.setQueryData(key, d),
    onError: (e) => toast.error("Couldn't change it", errorMessage(e)),
  });
  const payout = useMutation({
    mutationFn: () => unwrap(api.POST("/staff/partners/{partner_id}/payout", { params: { path: { partner_id: paying!.id } }, body: { reference: ref.trim() } })),
    onSuccess: (d) => {
      toast.success("Payout recorded", rupees(d.paid_paise));
      setPaying(null);
      setRef("");
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <div className="space-y-6">
      <PageHeader title="Partners" description="Approve applications, and record payouts after paying a partner's UPI ID." />
      <Card className="overflow-x-auto p-0">
        <QueryState query={q} loading={<SkeletonRows rows={4} />}>
          {(rows: P[]) => (
            <Table label="Partners">
              <THead>
                <Tr>
                  <Th>Partner</Th>
                  <Th>Code</Th>
                  <Th>Businesses</Th>
                  <Th>Earned / paid / due</Th>
                  <Th>Status</Th>
                  <Th />
                </Tr>
              </THead>
              <TBody>
                {rows.map((p) => (
                  <Tr key={p.id}>
                    <Td>
                      <p className="font-medium">{p.firm || p.name}</p>
                      <p className="text-xs text-muted">
                        {p.name} · {p.kind} · {p.city ?? "—"} · {p.email} · {p.phone ?? "no phone"} · UPI {p.upi_id ?? "—"} · applied {formatDate(p.created_at)}
                      </p>
                    </Td>
                    <Td>{p.code}</Td>
                    <Td className="tabular-nums">{p.referrals}</Td>
                    <Td className="tabular-nums">
                      {rupees(p.earned_paise)} / {rupees(p.paid_paise)} / <strong>{rupees(p.due_paise)}</strong>
                    </Td>
                    <Td>
                      <Badge tone={p.status === "active" ? "success" : p.status === "applied" ? "info" : "neutral"}>{p.status}</Badge>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {p.status !== "active" ? (
                          <Button size="sm" variant="primary" onClick={() => setStatus.mutate({ id: p.id, status: "active" })}>
                            Approve
                          </Button>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => setStatus.mutate({ id: p.id, status: "paused" })}>
                            Pause
                          </Button>
                        )}
                        {p.status === "applied" ? (
                          <Button size="sm" variant="ghost" onClick={() => setStatus.mutate({ id: p.id, status: "rejected" })}>
                            Reject
                          </Button>
                        ) : null}
                        {p.due_paise > 0 ? (
                          <Button size="sm" onClick={() => setPaying(p)}>
                            Record payout
                          </Button>
                        ) : null}
                      </div>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </QueryState>
      </Card>
      {paying ? (
        <Dialog
          open
          onClose={() => setPaying(null)}
          title={`Pay ${paying.firm || paying.name} ${rupees(paying.due_paise)}`}
          description={`Send it to ${paying.upi_id ?? "their UPI ID"} first, then record the transfer's reference here.`}
          footer={
            <>
              <Button variant="ghost" onClick={() => setPaying(null)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={ref.trim().length < 3} loading={payout.isPending} onClick={() => payout.mutate()}>
                Record payout
              </Button>
            </>
          }
        >
          <Field label="UPI or bank reference">
            <Input value={ref} onChange={(e) => setRef(e.target.value)} maxLength={80} />
          </Field>
          <FormError message={error} />
        </Dialog>
      ) : null}
    </div>
  );
}
