"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Switch } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page";
import { EmptyState, QueryState, SkeletonRows } from "@/components/ui/states";
import { TBody, THead, Table, Td, Th, Tr } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatDate } from "@/lib/format";

type C = Schemas["StaffCoupon"];

/** Kritvia's team: coupons, how many places are left, and who used them. */
export default function StaffCouponsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["staff", "coupons"] as const;
  const q = useQuery({ queryKey: key, queryFn: () => unwrap(api.GET("/staff/coupons")) });
  const set = useMutation({
    mutationFn: (c: C) => unwrap(api.PATCH("/staff/coupons/{code}", { params: { path: { code: c.code } }, body: { active: !c.active } })),
    onSuccess: (d) => qc.setQueryData(key, d),
    onError: (e) => toast.error("Couldn't change it", errorMessage(e)),
  });
  const link = (code: string) => `${window.location.origin}/register?coupon=${code}`;
  return (
    <>
      <PageHeader title="Coupons" description="Free months of a plan for the first businesses that use a code. Nothing is charged because of a coupon." />
      <QueryState query={q} loading={<SkeletonRows rows={3} />}>
        {(rows: C[]) => (
          <div className="space-y-4">
            {rows.map((c) => (
              <Card key={c.code}>
                <CardHeader
                  title={
                    <span className="flex items-center gap-2">
                      {c.code} {c.active ? <Badge tone="success">open</Badge> : <Badge>off</Badge>}
                    </span>
                  }
                  description={`${c.offer} · ${c.uses} of ${c.max_uses} used, ${Math.max(c.max_uses - c.uses, 0)} left${c.note ? ` · ${c.note}` : ""}`}
                  actions={
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Copy className="h-4 w-4" />}
                        onClick={() => void navigator.clipboard.writeText(link(c.code)).then(() => toast.success("Sign-up link copied", link(c.code)))}
                      >
                        Copy sign-up link
                      </Button>
                      <Switch checked={c.active} onChange={() => set.mutate(c)} label={`${c.code} can be used`} />
                    </div>
                  }
                />
                {c.used_by.length ? (
                  <Table>
                    <THead>
                      <Tr>
                        <Th>Organisation</Th>
                        <Th>Owner</Th>
                        <Th>Used</Th>
                        <Th>Free until</Th>
                        <Th>Now pays</Th>
                      </Tr>
                    </THead>
                    <TBody>
                      {c.used_by.map((u) => (
                        <Tr key={u.org_id}>
                          <Td>{u.org_name ?? "—"}</Td>
                          <Td>{u.owner_email ?? "—"}</Td>
                          <Td>{formatDate(u.redeemed_at)}</Td>
                          <Td>{formatDate(u.ends_at)}</Td>
                          <Td>{u.paid_plan ? <Badge tone="success">{u.paid_plan}</Badge> : "—"}</Td>
                        </Tr>
                      ))}
                    </TBody>
                  </Table>
                ) : (
                  <EmptyState title="Not used yet" description="Share the sign-up link, or people can enter the code under Plan & billing." />
                )}
              </Card>
            ))}
          </div>
        )}
      </QueryState>
    </>
  );
}
