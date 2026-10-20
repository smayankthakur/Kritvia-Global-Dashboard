"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gift } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { FormError, Input } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatDate } from "@/lib/format";

export function couponNote(c: Schemas["OrgCouponOut"] | undefined): string | null {
  if (!c?.code || !c.ends_at) return null;
  if (c.superseded) return null;
  if (c.running) return `Free with ${c.code} until ${formatDate(c.ends_at)}. After that, choose a plan within 7 days to keep going.`;
  return `Your free ${c.plan_name} months with ${c.code} ended on ${formatDate(c.ends_at)}.`;
}

/** Plan & billing: "Have a coupon?", and the coupons the organisation is using (one of each kind). */
export function CouponCard({ orgId, isOwner }: { orgId: string; isOwner: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ["org-coupon", orgId] as const;
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      unwrap(
        api.GET("/orgs/{org_id}/coupon", {
          params: { path: { org_id: orgId } },
        }),
      ),
  });
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const use = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/orgs/{org_id}/coupon", {
          params: { path: { org_id: orgId } },
          body: { code: code.trim() },
        }),
      ),
    onSuccess: (d) => {
      qc.setQueryData(key, d);
      void qc.invalidateQueries({ queryKey: ["plan", orgId] });
      setError(null);
      const added = (d.coupons ?? []).find((x) => x.code === code.trim().toUpperCase());
      setCode("");
      toast.success(`${code.trim().toUpperCase()} applied`, added?.offer);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  if (!q.data) return null;
  const c = q.data;
  const list = c.coupons ?? [];
  if (!list.length && !isOwner) return null;
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Gift className="h-4 w-4 text-subtle" aria-hidden /> Coupons
          </span>
        }
        description={
          couponNote(c) ?? "Have a coupon? Enter it here. A free plan or extra trial days never charge anything; a discount applies when you subscribe."
        }
      />
      {list.length ? (
        <ul className="space-y-1 px-4 pb-2 text-sm" aria-label="Coupons used">
          {list.map((x) => (
            <li key={x.code} className="flex flex-wrap items-center gap-2">
              <span className="font-mono font-medium">{x.code}</span>
              <span className="text-muted">{x.offer}</span>
              <Badge tone={x.used ? "neutral" : x.running ? "success" : "neutral"}>
                {x.used ? "used" : x.running ? `until ${formatDate(x.ends_at)}` : `ended ${formatDate(x.ends_at)}`}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      {isOwner ? (
        <form
          className="flex gap-2 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim().length >= 3) use.mutate();
          }}
        >
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ""))}
            maxLength={24}
            placeholder="FIRST50"
            aria-label="Coupon code"
          />
          <Button type="submit" loading={use.isPending}>
            Apply
          </Button>
        </form>
      ) : null}
      <div className="px-4 pb-4">
        {isOwner ? (
          <p className="mb-2 text-xs text-subtle">
            Applying a coupon means you accept its conditions in clause 10.10 of the{" "}
            <a href="/terms" target="_blank" rel="noreferrer" className="underline">
              Terms
            </a>
            .
          </p>
        ) : null}
        <FormError message={error} />
      </div>
    </Card>
  );
}
