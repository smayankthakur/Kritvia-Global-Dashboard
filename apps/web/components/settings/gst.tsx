"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ReceiptIndianRupee } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Field, FormError, Input, Textarea } from "@/components/ui/field";
import { ErrorState, SkeletonRows } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";

type Profile = Schemas["GstProfile"];
const EMPTY: Profile = { legal_name: "", trade_name: "", gstin: "", address: "", email: "", phone: "", prefix: "INV", terms: "" };

export const gstKey = (ventureId: string) => ["gst-profile", ventureId] as const;

/** The business's details printed on every GST tax invoice. */
export function GstCard({ ventureId }: { ventureId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: gstKey(ventureId),
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/gst-profile", { params: { path: { venture_id: ventureId } } })),
  });
  const [form, setForm] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (b: Profile) => unwrap(api.PUT("/ventures/{venture_id}/gst-profile", { params: { path: { venture_id: ventureId } }, body: b })),
    onSuccess: (d) => {
      qc.setQueryData(gstKey(ventureId), d);
      setForm(null);
      setError(null);
      toast.success("GST details saved", `Your next tax invoice will be ${d.next_number}.`);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const header = (
    <CardHeader
      title={
        <span className="flex items-center gap-2">
          <ReceiptIndianRupee className="h-4 w-4 text-subtle" aria-hidden /> GST invoices
        </span>
      }
      description="Your details on every tax invoice. Kritvia numbers them per financial year and works out CGST and SGST, or IGST for other states."
      actions={q.data?.state ? <Badge tone="success" dot>{q.data.state.name}</Badge> : undefined}
    />
  );
  if (q.isLoading) return <Card>{header}<SkeletonRows rows={3} /></Card>;
  if (q.isError || !q.data) return <Card>{header}<ErrorState error={q.error} onRetry={() => void q.refetch()} /></Card>;
  const d = q.data;
  const f = form ?? { ...EMPTY, ...(d.profile ?? {}) };
  const set = (k: keyof Profile) => (v: string) => setForm({ ...f, [k]: v });
  const ro = !d.can_edit;

  return (
    <Card>
      {header}
      <form
        className="grid gap-3 p-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          const gstin = f.gstin.replace(/\s/g, "").toUpperCase();
          if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) return setError("A GSTIN has 15 characters, e.g. 27AAPFU0939F1ZV.");
          save.mutate({ ...f, gstin, prefix: f.prefix.toUpperCase(), trade_name: f.trade_name || null, email: f.email || null, phone: f.phone || null, terms: f.terms || null });
        }}
      >
        <Field label="Legal name (as on GST registration)" required>
          <Input value={f.legal_name} onChange={(e) => set("legal_name")(e.target.value)} maxLength={160} disabled={ro} />
        </Field>
        <Field label="Trade name (optional)">
          <Input value={f.trade_name ?? ""} onChange={(e) => set("trade_name")(e.target.value)} maxLength={160} disabled={ro} />
        </Field>
        <Field label="GSTIN" required hint="Your state comes from its first two digits">
          <Input value={f.gstin} onChange={(e) => set("gstin")(e.target.value)} maxLength={20} autoCapitalize="characters" disabled={ro} />
        </Field>
        <Field label="Invoice number prefix" hint={d.next_number ? `Next: ${d.next_number}` : "Up to 5 letters or digits, e.g. GS"}>
          <Input value={f.prefix} onChange={(e) => set("prefix")(e.target.value)} maxLength={5} disabled={ro} />
        </Field>
        <Field label="Address" required className="sm:col-span-2">
          <Textarea rows={2} value={f.address} onChange={(e) => set("address")(e.target.value)} maxLength={400} disabled={ro} />
        </Field>
        <Field label="Email on invoices">
          <Input type="email" value={f.email ?? ""} onChange={(e) => set("email")(e.target.value)} maxLength={254} disabled={ro} />
        </Field>
        <Field label="Phone on invoices">
          <Input value={f.phone ?? ""} onChange={(e) => set("phone")(e.target.value)} maxLength={24} disabled={ro} />
        </Field>
        <Field label="Printed at the foot" hint="Bank details, payment terms" className="sm:col-span-2">
          <Textarea rows={2} value={f.terms ?? ""} onChange={(e) => set("terms")(e.target.value)} maxLength={600} disabled={ro} />
        </Field>
        <div className="sm:col-span-2">
          <FormError message={error} />
          <Button type="submit" variant="primary" disabled={ro || !form} loading={save.isPending}>
            Save GST details
          </Button>
        </div>
      </form>
    </Card>
  );
}
