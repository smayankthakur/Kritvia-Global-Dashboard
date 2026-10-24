"use client";

import { useQuery } from "@tanstack/react-query";
import { Download, ReceiptIndianRupee } from "lucide-react";
import { useEffect, useState } from "react";
import { rupees } from "@/components/invoices/money";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { GstCard, gstKey } from "@/components/settings/gst";
import { Notice } from "@/components/ui/page";
import { Stat, StatGrid } from "@/components/ui/stat";
import { EmptyState, QueryState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { ApiError, api, downloadFile, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { formatDate } from "@/lib/format";

function lastMonth(): string {
  const d = new Date(Date.now() + 330 * 60_000);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

/** The month's GSTR-1, built from the tax invoices made in Kritvia: Excel (the GST offline tool's sheets) or JSON. */
export function GstTab({ ventureId, initialMonth }: { ventureId: string; initialMonth?: string | null }) {
  const toast = useToast();
  const [month, setMonth] = useState(initialMonth && /^\d{4}-\d{2}$/.test(initialMonth) ? initialMonth : lastMonth());
  const q = useQuery({
    queryKey: ["gstr1", ventureId, month],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/gst/gstr1", { params: { path: { venture_id: ventureId }, query: { month } } })),
    retry: false,
  });
  // A 409 is a setup step, not an error: the business has no GST details yet (round 3, A12).
  const needsSetup = q.error instanceof ApiError && q.error.status === 409;
  const [settingUp, setSettingUp] = useState(false);
  const profile = useQuery({
    queryKey: gstKey(ventureId),
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/gst-profile", { params: { path: { venture_id: ventureId } } })),
    enabled: needsSetup,
  });
  const hasProfile = Boolean(profile.data?.profile);
  const { refetch } = q;
  useEffect(() => {
    if (needsSetup && hasProfile) void refetch();
  }, [needsSetup, hasProfile, refetch]);
  const get = (format: "xlsx" | "json") =>
    downloadFile(`/ventures/${ventureId}/gst/gstr1/file?month=${month}&format=${format}`, `GSTR1_${month}.${format}`).catch((e) =>
      toast.error("Couldn't download it", errorMessage(e)),
    );
  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-end gap-3 p-4">
        <Field label="Month" className="w-44">
          <Input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </Field>
        <Button variant="primary" icon={<Download className="h-4 w-4" />} onClick={() => void get("xlsx")} disabled={!q.data}>
          Excel for the offline tool
        </Button>
        <Button icon={<Download className="h-4 w-4" />} onClick={() => void get("json")} disabled={!q.data}>
          GSTR-1 JSON
        </Button>
      </Card>
      {needsSetup ? (
        settingUp ? (
          <GstCard ventureId={ventureId} />
        ) : (
          <Card>
            <EmptyState
              icon={ReceiptIndianRupee}
              title="Set up your GST profile first"
              description="Add your GSTIN, state and invoice numbering once. Then Kritvia makes tax invoices and builds this GSTR-1 sheet from them every month."
              action={
                <Button variant="primary" onClick={() => setSettingUp(true)}>
                  Set up GST
                </Button>
              }
            />
          </Card>
        )
      ) : (
      <QueryState query={q} loading={<SkeletonRows rows={2} className="p-3" />}>
        {(d: Schemas["Gstr1Out"]) => (
          <>
            <Card className="p-4">
              <StatGrid>
                <Stat label="Tax invoices" value={d.totals.invoices ?? 0} hint={d.totals.cancelled ? `${d.totals.cancelled} cancelled` : undefined} />
                <Stat label="Taxable value" value={rupees(d.totals.taxable_paise ?? 0)} />
                <Stat label="GST" value={rupees(d.totals.tax_paise ?? 0)} />
                <Stat label="Due by" value={formatDate(d.due_on)} hint="monthly filers" />
              </StatGrid>
              <p className="mt-3 text-xs text-subtle">
                {`${d.totals.b2b ?? 0} to registered buyers (B2B), ${d.totals.b2cl ?? 0} large inter-state B2C, ${d.totals.b2cs_rows ?? 0} B2C summary row(s), ${d.totals.hsn_rows ?? 0} HSN row(s). GSTIN ${d.gstin}.`}
              </p>
            </Card>
            {d.problems.map((p) => (
              <Notice key={p} tone="warning" title="Check before filing">
                {p}
              </Notice>
            ))}
            <p className="text-xs text-subtle">
              Only the tax invoices made in Kritvia are here. Credit notes, exports, advances and invoices made elsewhere must be added by your
              accountant. Kritvia doesn&apos;t file returns; it tells you on the 3rd of each month when last month&apos;s sheet is ready.
            </p>
          </>
        )}
      </QueryState>
      )}
    </div>
  );
}
