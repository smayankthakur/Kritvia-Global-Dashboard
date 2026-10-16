"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Handshake } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { FormError, Input } from "@/components/ui/field";
import { api, errorMessage, unwrap } from "@/lib/api";

/** "Came through a CA or agency?": the partner's code, or who the organisation came through. */
export function PartnerCodeCard({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const key = ["org-partner", orgId] as const;
  const q = useQuery({ queryKey: key, queryFn: () => unwrap(api.GET("/orgs/{org_id}/partner", { params: { path: { org_id: orgId } } })) });
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const use = useMutation({
    mutationFn: () => unwrap(api.POST("/orgs/{org_id}/partner-code", { params: { path: { org_id: orgId } }, body: { code: code.trim() } })),
    onSuccess: (d) => {
      qc.setQueryData(key, d);
      setError(null);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  if (!q.data) return null;
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Handshake className="h-4 w-4 text-subtle" aria-hidden /> Partner
          </span>
        }
        description={q.data.partner ? `You came through ${q.data.partner}: ${q.data.discount}.` : "Did a CA or agency recommend Kritvia? Enter their partner code for 10% off your first 3 months."}
      />
      {!q.data.partner ? (
        <form
          className="flex gap-2 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim().length >= 4) use.mutate();
          }}
        >
          <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={12} placeholder="MEHTA10" aria-label="Partner code" />
          <Button type="submit" loading={use.isPending}>
            Apply
          </Button>
        </form>
      ) : null}
      <div className="px-4 pb-4">
        <FormError message={error} />
      </div>
    </Card>
  );
}
