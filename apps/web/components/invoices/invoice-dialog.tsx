"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileUp, Landmark } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { CopyField } from "@/components/ui/copy";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, FormError, Input, Select, Textarea } from "@/components/ui/field";
import { Notice } from "@/components/ui/page";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, multipart, unwrap, type Schemas } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { dueLabel, paiseToInput, rupees, toPaise } from "./money";

export type Invoice = Schemas["InvoiceOut"];
type Source = "manual" | "file" | "tally";

interface FormState {
  number: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  amount: string;
  issued_on: string;
  due_on: string;
  notes: string;
}

/** A wa.me link that opens WhatsApp with the payment page ready to send (the person sends it). */
export function whatsappShare(i: Invoice): string {
  const text = `Hi ${i.customer_name}, here is ${i.number ? `invoice ${i.number}` : "your invoice"} for ${rupees(i.balance_paise)}. You can pay by UPI here: ${i.pay_url}`;
  return `https://wa.me/${i.customer_phone}?text=${encodeURIComponent(text)}`;
}

function istToday(offsetDays = 0): string {
  return new Date(Date.now() + 330 * 60_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function fromInvoice(i: Invoice | null): FormState {
  return {
    number: i?.number ?? "",
    customer_name: i?.customer_name ?? "",
    customer_email: i?.customer_email ?? "",
    customer_phone: i?.customer_phone ? `+${i.customer_phone}` : "",
    amount: paiseToInput(i?.amount_paise),
    issued_on: i?.issued_on ?? istToday(),
    due_on: i?.due_on ?? istToday(15),
    notes: i?.notes ?? "",
  };
}

/** Problems with the form, or null. */
export function formProblem(f: FormState): string | null {
  if (!f.customer_name.trim()) return "Who is the invoice for?";
  if (toPaise(f.amount) === null) return "Write the amount in rupees, e.g. 11800 or 11,800.50.";
  if (!f.due_on) return "Pick the due date.";
  if (f.issued_on && f.due_on < f.issued_on) return "The due date is before the invoice date.";
  if (f.customer_email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.customer_email.trim())) return "That email address doesn't look right.";
  return null;
}

/** Add an invoice (typed, read from a photo or PDF, or from Tally), or open one to edit, record a payment,
 * pause reminders, cancel or delete it. */
export function InvoiceDialog({
  ventureId,
  invoice,
  open,
  onClose,
  canWrite,
  canAdmin,
}: {
  ventureId: string;
  invoice: Invoice | null;
  open: boolean;
  onClose: () => void;
  canWrite: boolean;
  canAdmin: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<FormState>(() => fromInvoice(invoice));
  const [source, setSource] = useState<Source>("manual");
  const [unsure, setUnsure] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [payment, setPayment] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showTally, setShowTally] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const editing = invoice !== null;
  const done = () => void qc.invalidateQueries({ queryKey: ["invoices", ventureId] });
  const set = (k: keyof FormState) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const body = () => ({
    number: form.number.trim(),
    customer_name: form.customer_name.trim(),
    customer_email: form.customer_email.trim() || null,
    customer_phone: form.customer_phone.replace(/[^\d+]/g, "") ? form.customer_phone.trim() : null,
    amount_paise: toPaise(form.amount)!,
    issued_on: form.issued_on || null,
    due_on: form.due_on,
    notes: form.notes.trim() || null,
  });
  const isDraft = editing && invoice.status === "draft";
  const save = useMutation({
    mutationFn: (issue: boolean = false) =>
      editing
        ? unwrap(
            api.PATCH("/ventures/{venture_id}/invoices/{invoice_id}", {
              params: { path: { venture_id: ventureId, invoice_id: invoice.id } },
              body: issue ? { ...body(), status: "open" } : body(),
            }),
          )
        : unwrap(api.POST("/ventures/{venture_id}/invoices", { params: { path: { venture_id: ventureId } }, body: { ...body(), source } })),
    onSuccess: (_d, issue) => {
      toast.success(issue ? "Invoice issued. Reminders and the payment page are on." : editing ? "Invoice updated" : "Invoice added");
      done();
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const read = useMutation({
    mutationFn: (file: File) =>
      unwrap(
        api.POST("/ventures/{venture_id}/invoices/read", {
          params: { path: { venture_id: ventureId } },
          body: multipart<Schemas["Body_read_invoice_ventures__venture_id__invoices_read_post"]>({ file }),
        }),
      ),
    onSuccess: (d) => {
      setForm((f) => ({
        number: d.number || f.number,
        customer_name: d.customer_name || f.customer_name,
        customer_email: d.customer_email ?? f.customer_email,
        customer_phone: d.customer_phone ? `+${d.customer_phone}` : f.customer_phone,
        amount: d.amount_paise ? paiseToInput(d.amount_paise) : f.amount,
        issued_on: d.issued_on ?? f.issued_on,
        due_on: d.due_on ?? f.due_on,
        notes: f.notes,
      }));
      setUnsure(d.unsure ?? []);
      setSource("file");
      setError(null);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const pay = useMutation({
    mutationFn: (p: number | { amount_paise: number; method: "upi"; reference: string | null }) =>
      unwrap(
        api.POST("/ventures/{venture_id}/invoices/{invoice_id}/payment", {
          params: { path: { venture_id: ventureId, invoice_id: invoice!.id } },
          body: typeof p === "number" ? { amount_paise: p, method: "manual" } : p,
        }),
      ),
    onSuccess: (i) => {
      toast.success(i.status === "paid" ? "Marked as paid. Reminders stop." : `Payment recorded; ${rupees(i.balance_paise)} still due`);
      setPayment("");
      done();
      if (i.status === "paid") onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const patch = useMutation({
    mutationFn: (b: Schemas["InvoicePatch"]) =>
      unwrap(api.PATCH("/ventures/{venture_id}/invoices/{invoice_id}", { params: { path: { venture_id: ventureId, invoice_id: invoice!.id } }, body: b })),
    onSuccess: () => done(),
    onError: (e) => setError(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE("/ventures/{venture_id}/invoices/{invoice_id}", { params: { path: { venture_id: ventureId, invoice_id: invoice!.id } } })),
    onSuccess: () => {
      toast.success("Invoice deleted");
      done();
      setConfirmDelete(false);
      onClose();
    },
    onError: (e) => toast.error("Could not delete", errorMessage(e)),
  });
  const tally = useQuery({
    queryKey: ["tally", ventureId],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/tally", { params: { path: { venture_id: ventureId } } })),
    enabled: showTally,
  });

  const submit = (e?: FormEvent, issue = false) => {
    e?.preventDefault();
    const p = formProblem(form);
    if (p) return setError(p);
    setError(null);
    save.mutate(issue);
  };
  const readOnly = !canWrite || (editing && invoice.status !== "open" && invoice.status !== "draft");
  const flag = (k: string) => (unsure.includes(k) ? "Check this: it wasn't clear on the file" : undefined);
  const due = invoice ? dueLabel(invoice) : null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={editing ? `${invoice.customer_name}${invoice.number ? ` · ${invoice.number}` : ""}` : "Add an invoice"}
      description={
        isDraft ? (
          <span className="flex flex-wrap items-center gap-2">
            {rupees(invoice.amount_paise)}, not issued yet
            {due ? <Badge tone={due.tone}>{due.text}</Badge> : null}
          </span>
        ) : editing ? (
          <span className="flex flex-wrap items-center gap-2">
            {rupees(invoice.balance_paise)} still due of {rupees(invoice.amount_paise)}
            {due ? <Badge tone={due.tone}>{due.text}</Badge> : null}
          </span>
        ) : (
          "Type it in, or fill it from a photo or PDF of the invoice, or from Tally."
        )
      }
      footer={
        readOnly ? null : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            {isDraft ? (
              <>
                <Button loading={save.isPending && !save.variables} onClick={() => submit()}>
                  Save draft
                </Button>
                <Button variant="primary" loading={save.isPending && Boolean(save.variables)} onClick={() => submit(undefined, true)}>
                  Issue invoice
                </Button>
              </>
            ) : (
              <Button variant="primary" loading={save.isPending} onClick={() => submit()}>
                {editing ? "Save changes" : "Add invoice"}
              </Button>
            )}
          </>
        )
      }
    >
      <div className="space-y-4">
        {isDraft ? (
          <Notice tone="info" title="Kritvia drafted this invoice">
            {invoice.source === "booking" ? "From a booking that was marked done." : "From the proposal the customer accepted."} Nothing has
            gone to the customer. Check the amount and details, then press Issue invoice: it is dated today, gets its payment page, and
            payment reminders can start.
            {canWrite ? (
              <div className="mt-2">
                <Button size="sm" variant="ghost" loading={patch.isPending} onClick={() => patch.mutate({ status: "cancelled" }, { onSuccess: onClose })}>
                  Not needed: discard the draft
                </Button>
              </div>
            ) : null}
          </Notice>
        ) : null}
        {!editing && canWrite ? (
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*"
              className="sr-only"
              aria-label="Invoice photo or PDF"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) read.mutate(f);
                e.target.value = "";
              }}
            />
            <Button size="sm" loading={read.isPending} onClick={() => fileRef.current?.click()} icon={<FileUp className="h-4 w-4" />}>
              Fill from a photo or PDF
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowTally((s) => !s)} icon={<Landmark className="h-4 w-4" />} aria-expanded={showTally}>
              From Tally
            </Button>
          </div>
        ) : null}
        {read.isPending ? <p className="text-sm text-muted" role="status">Reading the invoice…</p> : null}
        {source === "file" && !read.isPending ? (
          <Notice tone="info">Filled from the file. Check every field before adding{unsure.length ? "; the highlighted ones weren't clear" : ""}.</Notice>
        ) : null}
        {showTally ? (
          tally.isPending ? (
            <p className="text-sm text-muted">Loading what Tally shows…</p>
          ) : tally.data?.receivables.length ? (
            <Field label="Customers Tally shows as owing money" hint="Picks the name and the amount; add a due date and an email or phone for reminders.">
              <Select
                defaultValue=""
                onChange={(e) => {
                  const r = tally.data!.receivables.find((x) => x.party === e.target.value);
                  if (!r) return;
                  const p = toPaise(String(r.outstanding_inr));
                  setForm((f) => ({ ...f, customer_name: r.party, amount: p ? paiseToInput(p) : f.amount, notes: f.notes || `Balance from Tally, last entry ${formatDate(r.last_voucher)}` }));
                  setSource("tally");
                }}
              >
                <option value="">Choose a customer…</option>
                {tally.data.receivables.map((r) => (
                  <option key={r.party} value={r.party}>
                    {r.party} · {rupees(toPaise(String(r.outstanding_inr)) ?? 0)}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <p className="text-sm text-muted">Nothing from Tally yet. Import your Tally day book in Settings → Connectors first.</p>
          )
        ) : null}
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" noValidate>
          <Field label="Customer" required error={flag("customer_name")}>
            <Input value={form.customer_name} onChange={(e) => set("customer_name")(e.target.value)} maxLength={160} disabled={readOnly} />
          </Field>
          <Field label="Invoice number" error={flag("number")}>
            <Input value={form.number} onChange={(e) => set("number")(e.target.value)} maxLength={60} disabled={readOnly} />
          </Field>
          <Field label="Amount (₹)" required hint={editing && invoice.paid_paise ? `${rupees(invoice.paid_paise)} paid so far` : undefined} error={flag("amount_paise")}>
            <Input value={form.amount} onChange={(e) => set("amount")(e.target.value)} inputMode="decimal" placeholder="11800" disabled={readOnly} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Invoice date" error={flag("issued_on")}>
              <Input type="date" value={form.issued_on} onChange={(e) => set("issued_on")(e.target.value)} disabled={readOnly} />
            </Field>
            <Field label="Due date" required error={flag("due_on")}>
              <Input type="date" value={form.due_on} onChange={(e) => set("due_on")(e.target.value)} disabled={readOnly} />
            </Field>
          </div>
          <Field label="Email for reminders" error={flag("customer_email")}>
            <Input type="email" value={form.customer_email} onChange={(e) => set("customer_email")(e.target.value)} maxLength={254} disabled={readOnly} />
          </Field>
          <Field label="WhatsApp number" hint="Reminders by WhatsApp only reach customers who chat with you there" error={flag("customer_phone")}>
            <Input value={form.customer_phone} onChange={(e) => set("customer_phone")(e.target.value)} inputMode="tel" placeholder="+91 98111 22233" maxLength={24} disabled={readOnly} />
          </Field>
          <Field label="Notes" className="sm:col-span-2">
            <Textarea rows={2} value={form.notes} onChange={(e) => set("notes")(e.target.value)} maxLength={1000} disabled={readOnly} />
          </Field>
          <button type="submit" hidden />
        </form>
        <FormError message={error} />

        {editing && invoice.status === "open" ? (
          <div className="space-y-3 rounded-lg border border-border p-3">
            {invoice.customer_says_paid_at ? (
              <Notice tone="warning" title="The customer says they paid">
                On {formatDate(invoice.customer_says_paid_at)}
                {invoice.customer_paid_ref ? `, UPI reference ${invoice.customer_paid_ref}` : ""}. Check your bank or UPI app, then
                confirm it.
                {canWrite ? (
                  <div className="mt-2">
                    <Button
                      size="sm"
                      variant="primary"
                      loading={pay.isPending}
                      onClick={() => pay.mutate({ amount_paise: invoice.balance_paise, method: "upi", reference: invoice.customer_paid_ref ?? null })}
                    >
                      It arrived: paid in full ({rupees(invoice.balance_paise)})
                    </Button>
                  </div>
                ) : null}
              </Notice>
            ) : null}
            <CopyField label="Payment page (UPI QR, and card or netbanking if you connected Razorpay)" value={invoice.pay_url} />
            <div className="flex flex-wrap gap-2">
              <a className="text-sm font-medium text-accent underline underline-offset-2" href={invoice.pay_url} target="_blank" rel="noreferrer">
                Open the page
              </a>
              <a
                className="text-sm font-medium text-accent underline underline-offset-2"
                href={`/print/invoice/${ventureId}/${invoice.id}`}
                target="_blank"
                rel="noreferrer"
              >
                {invoice.kind === "gst" ? "Print or save the tax invoice" : "Print or save as PDF"}
              </a>
              {invoice.customer_phone ? (
                <a
                  className="text-sm font-medium text-accent underline underline-offset-2"
                  href={whatsappShare(invoice)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Send on WhatsApp
                </a>
              ) : null}
            </div>
          </div>
        ) : null}

        {editing && invoice.status === "open" && canWrite ? (
          <div className="space-y-3 rounded-lg border border-border p-3">
            <p className="text-sm font-medium">Record a payment</p>
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Amount received (₹)" className="w-44">
                <Input value={payment} onChange={(e) => setPayment(e.target.value)} inputMode="decimal" placeholder={paiseToInput(invoice.balance_paise)} />
              </Field>
              <Button
                variant="primary"
                loading={pay.isPending}
                onClick={() => {
                  const p = payment.trim() ? toPaise(payment) : invoice.balance_paise;
                  if (!p) return setError("Write the amount received in rupees.");
                  pay.mutate(p);
                }}
              >
                {payment.trim() ? "Record payment" : `Paid in full (${rupees(invoice.balance_paise)})`}
              </Button>
            </div>
            <Checkbox
              checked={invoice.reminders_paused}
              onChange={(e) => patch.mutate({ reminders_paused: e.target.checked })}
              label="Pause reminders for this invoice"
              hint="e.g. they promised to pay on a date, or they're querying the invoice"
            />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" onClick={() => patch.mutate({ status: "cancelled" }, { onSuccess: onClose })}>
                Cancel this invoice
              </Button>
              {canAdmin ? (
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
                  Delete
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
        {editing && invoice.status === "cancelled" && canWrite ? (
          <Button size="sm" onClick={() => patch.mutate({ status: "open" }, { onSuccess: onClose })}>
            Reopen this invoice
          </Button>
        ) : null}
        {editing && invoice.status !== "open" && canAdmin ? (
          <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => remove.mutate()}
        loading={remove.isPending}
        title="Delete this invoice?"
        description="It disappears from Kritvia for good, with its reminder history. Cancelling keeps the record instead."
        confirmLabel="Delete invoice"
      />
    </Dialog>
  );
}
