"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileUp, Plus } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { amountProblem, paiseToInput, rupees, toPaise, toPaiseOrZero } from "@/components/invoices/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input } from "@/components/ui/field";
import { Stat, StatGrid } from "@/components/ui/stat";
import { EmptyState, QueryState, SkeletonRows } from "@/components/ui/states";
import { Tabs } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, multipart, unwrap, type Schemas } from "@/lib/api";
import { formatDate, istDate } from "@/lib/format";

type Bill = Schemas["SupplierBillOut"];
type Show = "open" | "overdue" | "paid" | "all";

interface Form {
  vendor: string;
  number: string;
  vendor_gstin: string;
  amount: string;
  gst: string;
  bill_date: string;
  due_on: string;
  category: string;
  notes: string;
}

const EMPTY: Form = { vendor: "", number: "", vendor_gstin: "", amount: "", gst: "", bill_date: "", due_on: istDate(15), category: "", notes: "" };

function dueText(b: Bill): { text: string; tone: "danger" | "warning" | "neutral" | "success" } {
  if (b.status === "paid") return { text: b.paid_on ? `Paid ${formatDate(b.paid_on)}` : "Paid", tone: "success" };
  if (b.status === "cancelled") return { text: "Cancelled", tone: "neutral" };
  if (b.overdue_days > 0) return { text: `${b.overdue_days} day${b.overdue_days === 1 ? "" : "s"} overdue`, tone: "danger" };
  return { text: `Due ${formatDate(b.due_on)}`, tone: "warning" };
}

/** What the business owes its suppliers. Kritvia reminds before the due date; it never pays by itself. */
export function BillsTab({ ventureId, canWrite }: { ventureId: string; canWrite: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [show, setShow] = useState<Show>("open");
  const [open, setOpen] = useState<Bill | "new" | null>(null);
  const [confirmPaid, setConfirmPaid] = useState<Bill | null>(null);
  const bills = useQuery({
    queryKey: ["bills", ventureId, show],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/bills", { params: { path: { venture_id: ventureId }, query: { show } } })),
  });
  const reopen = useMutation({
    mutationFn: (b: Bill) => unwrap(api.POST("/ventures/{venture_id}/bills/{bill_id}/reopen", { params: { path: { venture_id: ventureId, bill_id: b.id } } })),
    onSuccess: (b) => {
      toast.success("Back to pay", `${b.vendor}: ${rupees(b.balance_paise)}`);
      void qc.invalidateQueries({ queryKey: ["bills", ventureId] });
    },
    onError: (e) => toast.error("Couldn't undo it", errorMessage(e)),
  });
  const paid = useMutation({
    mutationFn: (b: Bill) => unwrap(api.POST("/ventures/{venture_id}/bills/{bill_id}/paid", { params: { path: { venture_id: ventureId, bill_id: b.id } }, body: {} })),
    onSuccess: (b) => {
      setConfirmPaid(null);
      toast.success("Marked paid", `${b.vendor}: ${rupees(b.amount_paise)}`, { label: "Undo", onClick: () => reopen.mutate(b) });
      void qc.invalidateQueries({ queryKey: ["bills", ventureId] });
    },
    onError: (e) => toast.error("Couldn't mark it paid", errorMessage(e)),
  });
  const t = bills.data?.totals;
  return (
    <div className="space-y-4">
      {t ? (
        <Card className="p-4">
          <StatGrid>
            <Stat label="To pay" value={rupees(t.to_pay_paise)} hint={`${t.open_count} bill${t.open_count === 1 ? "" : "s"}`} />
            <Stat label="Due in 7 days" value={rupees(t.due_this_week_paise)} tone={t.due_this_week_paise ? "warning" : undefined} />
            <Stat label="Overdue" value={rupees(t.overdue_paise)} hint={`${t.overdue_count} bill${t.overdue_count === 1 ? "" : "s"}`} tone={t.overdue_count ? "danger" : undefined} />
            <Stat label="Paid this month" value={rupees(t.paid_this_month_paise)} tone="success" />
          </StatGrid>
        </Card>
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Tabs
          label="Bills"
          value={show}
          onChange={(s) => setShow(s as Show)}
          items={[
            { id: "open", label: "To pay" },
            { id: "overdue", label: "Overdue" },
            { id: "paid", label: "Paid" },
            { id: "all", label: "All" },
          ]}
        />
        {canWrite ? (
          <Button variant="primary" onClick={() => setOpen("new")} icon={<Plus className="h-4 w-4" />}>
            Add a bill
          </Button>
        ) : null}
      </div>
      <Card className="overflow-hidden p-0">
        <QueryState query={bills} loading={<SkeletonRows rows={4} className="p-3" />}>
          {(d: Schemas["BillsOut"]) =>
            d.bills.length ? (
              <ul className="divide-y divide-border" aria-label="Bills">
                {d.bills.map((b) => {
                  const due = dueText(b);
                  return (
                    <li key={b.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-3">
                      <button type="button" className="min-w-0 truncate text-left font-medium hover:underline" onClick={() => setOpen(b)}>
                        {b.vendor}
                      </button>
                      <span className="text-right font-semibold tabular-nums">{rupees(b.status === "open" ? b.balance_paise : b.amount_paise)}</span>
                      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
                        {b.number ? <span>{b.number}</span> : null}
                        {b.category ? <span>· {b.category}</span> : null}
                        {b.source === "email" ? <Badge tone="info">from email: check it is real</Badge> : null}
                      </span>
                      <span className="flex items-center justify-end gap-2">
                        <Badge tone={due.tone}>{due.text}</Badge>
                        {b.status === "open" && canWrite ? (
                          <Button size="sm" variant="ghost" onClick={() => setConfirmPaid(b)}>
                            Paid
                          </Button>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState
                title={show === "open" ? "Nothing to pay" : "No bills here"}
                description="Add a bill by typing it or from a photo or PDF, or forward a supplier's bill email to your Kritvia address."
              />
            )
          }
        </QueryState>
      </Card>
      {open ? <BillDialog ventureId={ventureId} bill={open === "new" ? null : open} canWrite={canWrite} onClose={() => setOpen(null)} /> : null}
      <ConfirmDialog
        open={confirmPaid !== null}
        onClose={() => setConfirmPaid(null)}
        onConfirm={() => confirmPaid && paid.mutate(confirmPaid)}
        loading={paid.isPending}
        danger={false}
        confirmLabel="Mark paid"
        title={confirmPaid ? `Mark ${rupees(confirmPaid.balance_paise)} to ${confirmPaid.vendor} as paid?` : ""}
        description="It leaves To pay, the reminders and the cash forecast. You can undo it."
      />
    </div>
  );
}

function BillDialog({ ventureId, bill, canWrite, onClose }: { ventureId: string; bill: Bill | null; canWrite: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<Form>(() =>
    bill
      ? {
          vendor: bill.vendor,
          number: bill.number,
          vendor_gstin: bill.vendor_gstin ?? "",
          amount: paiseToInput(bill.amount_paise),
          gst: paiseToInput(bill.gst_paise),
          bill_date: bill.bill_date ?? "",
          due_on: bill.due_on,
          category: bill.category ?? "",
          notes: bill.notes ?? "",
        }
      : EMPTY,
  );
  const [source, setSource] = useState<"manual" | "file">("manual");
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const body = () => ({
    vendor: form.vendor.trim(),
    number: form.number.trim(),
    vendor_gstin: form.vendor_gstin.trim() || null,
    amount_paise: toPaise(form.amount)!,
    gst_paise: form.gst.trim() ? (toPaiseOrZero(form.gst) ?? 0) : 0,
    bill_date: form.bill_date || null,
    due_on: form.due_on,
    category: form.category.trim() || null,
    notes: form.notes.trim() || null,
  });
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["bills", ventureId] });
    onClose();
  };
  const save = useMutation({
    mutationFn: () =>
      bill
        ? unwrap(api.PATCH("/ventures/{venture_id}/bills/{bill_id}", { params: { path: { venture_id: ventureId, bill_id: bill.id } }, body: body() }))
        : unwrap(api.POST("/ventures/{venture_id}/bills", { params: { path: { venture_id: ventureId } }, body: { ...body(), source } })),
    onSuccess: () => {
      toast.success(bill ? "Bill updated" : "Bill added");
      done();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const [confirmCancel, setConfirmCancel] = useState(false);
  const cancel = useMutation({
    mutationFn: () => unwrap(api.PATCH("/ventures/{venture_id}/bills/{bill_id}", { params: { path: { venture_id: ventureId, bill_id: bill!.id } }, body: { status: "cancelled" } })),
    onSuccess: () => {
      toast.success("Bill cancelled");
      done();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const reopen = useMutation({
    mutationFn: () => unwrap(api.POST("/ventures/{venture_id}/bills/{bill_id}/reopen", { params: { path: { venture_id: ventureId, bill_id: bill!.id } } })),
    onSuccess: () => {
      toast.success("The bill is open again");
      done();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const amountError = amountProblem(form.amount);
  const gstError = amountProblem(form.gst, { zero: true });
  const read = useMutation({
    mutationFn: (file: File) =>
      unwrap(
        api.POST("/ventures/{venture_id}/bills/read", {
          params: { path: { venture_id: ventureId } },
          body: multipart<Schemas["Body_read_bill_ventures__venture_id__bills_read_post"]>({ file }),
        }),
      ),
    onSuccess: (d) => {
      setForm((f) => ({
        ...f,
        vendor: d.vendor || f.vendor,
        number: d.number || f.number,
        vendor_gstin: d.vendor_gstin ?? f.vendor_gstin,
        amount: d.amount_paise ? paiseToInput(d.amount_paise) : f.amount,
        gst: d.gst_paise ? paiseToInput(d.gst_paise) : f.gst,
        bill_date: d.bill_date ?? f.bill_date,
        due_on: d.due_on,
        category: d.category ?? f.category,
      }));
      setSource("file");
      setError(d.unsure.length ? `Check these, they weren't clear on the file: ${d.unsure.join(", ").replace(/_/g, " ")}` : null);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!form.vendor.trim()) return setError("Write the supplier's name.");
    if (!toPaise(form.amount)) return setError(amountProblem(form.amount) ?? "Write the bill's total in rupees.");
    if (gstError) return setError(`GST: ${gstError}`);
    if (!form.due_on) return setError("Choose the due date.");
    setError(null);
    save.mutate();
  };
  const readOnly = !canWrite || (bill !== null && bill.status !== "open");
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={bill ? `${bill.vendor}${bill.number ? ` · ${bill.number}` : ""}` : "Add a bill"}
      description={bill ? `${rupees(bill.balance_paise)} still to pay of ${rupees(bill.amount_paise)}` : "Type it in, or fill it from a photo or PDF of the bill."}
      footer={
        readOnly ? null : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" loading={save.isPending} onClick={() => submit()}>
              {bill ? "Save changes" : "Add bill"}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        {!bill && canWrite ? (
          <div>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*"
              className="sr-only"
              aria-label="Bill photo or PDF"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) read.mutate(f);
                e.target.value = "";
              }}
            />
            <Button size="sm" loading={read.isPending} onClick={() => fileRef.current?.click()} icon={<FileUp className="h-4 w-4" />}>
              Fill from a photo or PDF
            </Button>
          </div>
        ) : null}
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          <Field label="Supplier" required>
            <Input value={form.vendor} onChange={set("vendor")} maxLength={160} disabled={readOnly} />
          </Field>
          <Field label="Bill number">
            <Input value={form.number} onChange={set("number")} maxLength={60} disabled={readOnly} />
          </Field>
          <Field label="Total (₹)" required error={form.amount.trim() ? amountError : null}>
            <Input value={form.amount} onChange={set("amount")} inputMode="decimal" disabled={readOnly} />
          </Field>
          <Field label="GST in it (₹)" hint="for your input tax credit" error={gstError}>
            <Input value={form.gst} onChange={set("gst")} inputMode="decimal" disabled={readOnly} />
          </Field>
          <Field label="Bill date">
            <Input type="date" value={form.bill_date} onChange={set("bill_date")} disabled={readOnly} />
          </Field>
          <Field label="Due on" required>
            <Input type="date" value={form.due_on} onChange={set("due_on")} disabled={readOnly} />
          </Field>
          <Field label="Supplier's GSTIN">
            <Input value={form.vendor_gstin} onChange={set("vendor_gstin")} maxLength={15} disabled={readOnly} />
          </Field>
          <Field label="Category" hint="e.g. Rent, Raw material, Packaging">
            <Input value={form.category} onChange={set("category")} maxLength={60} disabled={readOnly} />
          </Field>
          <Field label="Notes" className="sm:col-span-2">
            <Input value={form.notes} onChange={set("notes")} maxLength={1000} disabled={readOnly} />
          </Field>
          <button type="submit" hidden />
        </form>
        <FormError message={error} />
        {bill && bill.status === "open" && canWrite ? (
          <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(true)}>
            Cancel this bill
          </Button>
        ) : null}
        {bill && bill.status !== "open" && canWrite ? (
          <Button size="sm" loading={reopen.isPending} onClick={() => reopen.mutate()}>
            {bill.status === "paid" ? "Not paid after all: reopen it" : "Reopen this bill"}
          </Button>
        ) : null}
        <ConfirmDialog
          open={confirmCancel}
          onClose={() => setConfirmCancel(false)}
          onConfirm={() => cancel.mutate()}
          loading={cancel.isPending}
          confirmLabel="Cancel the bill"
          cancelLabel="Keep it"
          title="Cancel this bill?"
          description="It stops counting as money you owe. You can reopen it later."
        />
      </div>
    </Dialog>
  );
}
