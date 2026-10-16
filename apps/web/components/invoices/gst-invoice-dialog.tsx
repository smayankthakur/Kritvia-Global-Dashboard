"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, FormError, Input, Select, Textarea } from "@/components/ui/field";
import { Notice } from "@/components/ui/page";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, unwrap } from "@/lib/api";
import { GST_RATES, lineTax } from "./gst-math";
import { rupees, toPaise } from "./money";

interface Row {
  description: string;
  hsn_sac: string;
  qty: string;
  unit: string;
  rate: string;
  discount: string;
  gst_rate: string;
}
const NEW_ROW: Row = { description: "", hsn_sac: "", qty: "1", unit: "", rate: "", discount: "", gst_rate: "18" };

/** Issue a GST tax invoice: numbered by Kritvia, taxed line by line. */
export function GstInvoiceDialog({ ventureId, open, onClose }: { ventureId: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const profile = useQuery({
    queryKey: ["gst-profile", ventureId],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/gst-profile", { params: { path: { venture_id: ventureId } } })),
  });
  const [c, setC] = useState({ name: "", gstin: "", address: "", pos: "", email: "", phone: "", due: "", notes: "" });
  const [reverse, setReverse] = useState(false);
  const [rows, setRows] = useState<Row[]>([{ ...NEW_ROW }]);
  const [error, setError] = useState<string | null>(null);

  const p = profile.data;
  const ownState = p?.state?.code ?? "";
  const gstinState = /^[0-9]{2}/.test(c.gstin.trim()) ? c.gstin.trim().slice(0, 2) : "";
  const pos = c.pos || gstinState || ownState;
  const same = pos === ownState;
  const lines = rows.map((r) => lineTax(r.qty || "0", toPaise(r.rate) ?? 0, toPaise(r.discount) ?? 0, r.gst_rate, same));
  const totals = lines.reduce(
    (a, l) => (l ? { taxable: a.taxable + l.taxable, tax: a.tax + l.cgst + l.sgst + l.igst } : a),
    { taxable: 0, tax: 0 },
  );

  const issue = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/ventures/{venture_id}/invoices/gst", {
          params: { path: { venture_id: ventureId } },
          body: {
            customer_name: c.name.trim(),
            customer_gstin: c.gstin.trim() || null,
            customer_address: c.address.trim() || null,
            place_of_supply: pos || null,
            customer_email: c.email.trim() || null,
            customer_phone: c.phone.trim() || null,
            due_on: c.due || null,
            reverse_charge: reverse,
            notes: c.notes.trim() || null,
            items: rows.map((r) => ({
              description: r.description.trim(),
              hsn_sac: r.hsn_sac.trim() || null,
              qty: r.qty.trim(),
              unit: r.unit.trim() || null,
              rate_paise: toPaise(r.rate) ?? 0,
              discount_paise: toPaise(r.discount) ?? 0,
              gst_rate: r.gst_rate,
            })),
          },
        }),
      ),
    onSuccess: (inv) => {
      toast.success(`Tax invoice ${inv.number} issued`, `${rupees(inv.amount_paise)} for ${inv.customer_name}.`);
      void qc.invalidateQueries({ queryKey: ["invoices", ventureId] });
      void qc.invalidateQueries({ queryKey: ["gst-profile", ventureId] });
      window.open(`/print/invoice/${ventureId}/${inv.id}`, "_blank", "noopener");
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const submit = () => {
    if (!c.name.trim()) return setError("Write the customer's name.");
    for (const [i, r] of rows.entries()) {
      if (!r.description.trim()) return setError(`Line ${i + 1}: write what it's for.`);
      if (!lines[i]) return setError(`Line ${i + 1}: the quantity should be a number, e.g. 1 or 2.5.`);
      if (toPaise(r.rate) === null && r.rate.trim() !== "0") return setError(`Line ${i + 1}: write the rate in rupees.`);
    }
    setError(null);
    issue.mutate();
  };
  const set = (k: keyof typeof c) => (v: string) => setC({ ...c, [k]: v });
  const setRow = (i: number, k: keyof Row, v: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title="New GST tax invoice"
      description={p?.next_number ? `It will be ${p.next_number}. Once issued, a tax invoice can't be re-priced; cancel it and issue a new one.` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={issue.isPending} disabled={!p?.profile} onClick={submit}>
            Issue {rupees(totals.taxable + totals.tax)}
          </Button>
        </>
      }
    >
      {p && !p.profile ? (
        <Notice tone="warning" title="Add your GST details first">
          Your GSTIN, legal name and address go on every tax invoice.{" "}
          <Link className="font-medium underline" href={`/v/${ventureId}/settings?tab=connectors`}>
            Settings → Connectors → GST invoices
          </Link>
        </Notice>
      ) : null}
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Customer" required>
            <Input value={c.name} onChange={(e) => set("name")(e.target.value)} maxLength={160} />
          </Field>
          <Field label="Customer's GSTIN" hint="If they are registered (they claim the tax back)">
            <Input value={c.gstin} onChange={(e) => set("gstin")(e.target.value.toUpperCase())} maxLength={20} />
          </Field>
          <Field label="Customer's address" className="sm:col-span-2">
            <Input value={c.address} onChange={(e) => set("address")(e.target.value)} maxLength={400} />
          </Field>
          <Field label="Place of supply" hint={same ? "Same state: CGST + SGST" : "Another state: IGST"}>
            <Select value={pos} onChange={(e) => set("pos")(e.target.value)}>
              {(p?.states ?? []).map((s) => (
                <option key={s.code} value={s.code}>
                  {s.code} · {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Due date" hint="Defaults to today">
            <Input type="date" value={c.due} onChange={(e) => set("due")(e.target.value)} />
          </Field>
          <Field label="Email for the invoice and reminders">
            <Input type="email" value={c.email} onChange={(e) => set("email")(e.target.value)} maxLength={254} />
          </Field>
          <Field label="WhatsApp number">
            <Input value={c.phone} onChange={(e) => set("phone")(e.target.value)} inputMode="tel" placeholder="+91 98111 22233" maxLength={24} />
          </Field>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Items</legend>
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-2 gap-2 rounded-lg border border-border p-2 sm:grid-cols-[2fr_1fr_0.7fr_0.7fr_1fr_0.9fr_0.8fr_auto] sm:items-end">
              <Field label={`Item ${i + 1}`} className="col-span-2 sm:col-span-1">
                <Input value={r.description} onChange={(e) => setRow(i, "description", e.target.value)} maxLength={300} />
              </Field>
              <Field label="HSN/SAC">
                <Input value={r.hsn_sac} onChange={(e) => setRow(i, "hsn_sac", e.target.value)} inputMode="numeric" maxLength={8} />
              </Field>
              <Field label="Qty">
                <Input value={r.qty} onChange={(e) => setRow(i, "qty", e.target.value)} inputMode="decimal" />
              </Field>
              <Field label="Unit">
                <Input value={r.unit} onChange={(e) => setRow(i, "unit", e.target.value)} maxLength={12} placeholder="pcs" />
              </Field>
              <Field label="Rate (₹)">
                <Input value={r.rate} onChange={(e) => setRow(i, "rate", e.target.value)} inputMode="decimal" />
              </Field>
              <Field label="Discount (₹)">
                <Input value={r.discount} onChange={(e) => setRow(i, "discount", e.target.value)} inputMode="decimal" />
              </Field>
              <Field label="GST %">
                <Select value={r.gst_rate} onChange={(e) => setRow(i, "gst_rate", e.target.value)}>
                  {GST_RATES.map((g) => (
                    <option key={g} value={g}>
                      {g}%
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove item ${i + 1}`}
                disabled={rows.length === 1}
                onClick={() => setRows(rows.filter((_, j) => j !== i))}
                icon={<Trash2 className="h-4 w-4" />}
              />
              {lines[i] ? (
                <p className="col-span-2 text-xs text-muted sm:col-span-8">
                  Taxable {rupees(lines[i]!.taxable)} · {same ? `CGST ${rupees(lines[i]!.cgst)} + SGST ${rupees(lines[i]!.sgst)}` : `IGST ${rupees(lines[i]!.igst)}`}
                </p>
              ) : null}
            </div>
          ))}
          <Button size="sm" icon={<Plus className="h-4 w-4" />} disabled={rows.length >= 100} onClick={() => setRows([...rows, { ...NEW_ROW }])}>
            Add a line
          </Button>
        </fieldset>

        <dl className="ml-auto grid max-w-xs grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
          <dt>Taxable value</dt>
          <dd className="text-right tabular-nums">{rupees(totals.taxable)}</dd>
          <dt>{same ? "CGST + SGST" : "IGST"}</dt>
          <dd className="text-right tabular-nums">{rupees(totals.tax)}</dd>
          <dt className="font-semibold">Total</dt>
          <dd className="text-right font-semibold tabular-nums">{rupees(totals.taxable + totals.tax)}</dd>
        </dl>
        <Checkbox checked={reverse} onChange={(e) => setReverse(e.target.checked)} label="Tax payable on reverse charge" />
        <Field label="Notes (printed on the invoice)">
          <Textarea rows={2} value={c.notes} onChange={(e) => set("notes")(e.target.value)} maxLength={1000} />
        </Field>
        <FormError message={error} />
      </div>
    </Dialog>
  );
}
