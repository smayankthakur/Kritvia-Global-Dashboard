"use client";

import { useQuery } from "@tanstack/react-query";
import { Plus, ReceiptIndianRupee, Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { GstInvoiceDialog } from "@/components/invoices/gst-invoice-dialog";
import { InvoiceDialog, type Invoice } from "@/components/invoices/invoice-dialog";
import { dueLabel, reminderLabel, rupees } from "@/components/invoices/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/field";
import { Notice, PageHeader } from "@/components/ui/page";
import { Stat, StatGrid } from "@/components/ui/stat";
import { EmptyState, QueryState, SkeletonRows } from "@/components/ui/states";
import { Tabs } from "@/components/ui/tabs";
import { api, unwrap, type Schemas } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useVenture } from "@/lib/venture";

type Show = "open" | "overdue" | "paid" | "all";

function Row({ inv, onOpen }: { inv: Invoice; onOpen: () => void }) {
  const due = dueLabel(inv);
  const reminders = reminderLabel(inv);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-3 text-left transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
      >
        <span className="min-w-0 truncate font-medium">{inv.customer_name}</span>
        <span className="text-right font-semibold tabular-nums">{rupees(inv.status === "open" ? inv.balance_paise : inv.amount_paise)}</span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-subtle">
          {inv.number ? <span>{inv.number}</span> : null}
          <span>{inv.status === "paid" && inv.paid_on ? `Paid ${formatDate(inv.paid_on)}` : `Due ${formatDate(inv.due_on)}`}</span>
          {reminders ? <span>· {reminders}</span> : null}
        </span>
        <span className="flex justify-end gap-1">
          {inv.status === "open" && inv.customer_says_paid_at ? <Badge tone="info">says paid</Badge> : null}
          <Badge tone={due.tone}>{due.text}</Badge>
        </span>
        {inv.status === "open" && inv.paid_paise ? (
          <span className="col-span-2 text-xs text-subtle">
            {rupees(inv.paid_paise)} paid of {rupees(inv.amount_paise)}
          </span>
        ) : null}
      </button>
    </li>
  );
}

export default function InvoicesPage() {
  const v = useVenture();
  const [show, setShow] = useState<Show>("open");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Invoice | "new" | null>(null);
  const [gstOpen, setGstOpen] = useState(false);
  const canWrite = v.access === "write";
  const canAdmin = Boolean(v.can_admin || v.is_owner);
  const invoices = useQuery({
    queryKey: ["invoices", v.id, show, q.trim()],
    queryFn: () =>
      unwrap(api.GET("/ventures/{venture_id}/invoices", { params: { path: { venture_id: v.id }, query: { show, q: q.trim() || undefined } } })),
  });
  const configs = useQuery({
    queryKey: ["workflow-configs", v.id],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/workflow-configs", { params: { path: { venture_id: v.id } } })),
  });
  const remindersOn = configs.data?.some((c) => c.workflow === "collections" && c.enabled);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={v.venture_name}
        title="Invoices"
        description="What customers owe you. Payment reminders go out by email or WhatsApp after you approve them, and stop when you record the payment."
        actions={
          canWrite ? (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setGstOpen(true)} icon={<ReceiptIndianRupee className="h-4 w-4" />}>
                New GST invoice
              </Button>
              <Button variant="primary" onClick={() => setOpen("new")} icon={<Plus className="h-4 w-4" />}>
                Add invoice
              </Button>
            </div>
          ) : undefined
        }
      />
      {configs.data && !remindersOn ? (
        <Notice tone="info" title="Payment reminders are off">
          Switch on{" "}
          <Link href={`/v/${v.id}/agents`} className="font-medium underline underline-offset-2">
            Payment reminders
          </Link>{" "}
          on the Agents page and Kritvia drafts a polite reminder before and after each due date, for your yes.
        </Notice>
      ) : null}
      {invoices.data ? (
        <Card className="p-4">
          <StatGrid>
            <Stat label="Still to collect" value={rupees(invoices.data.totals.outstanding_paise)} hint={`${invoices.data.totals.open_count} unpaid`} />
            <Stat
              label="Overdue"
              value={rupees(invoices.data.totals.overdue_paise)}
              hint={`${invoices.data.totals.overdue_count} invoice${invoices.data.totals.overdue_count === 1 ? "" : "s"}`}
              tone={invoices.data.totals.overdue_count ? "danger" : undefined}
            />
            <Stat label="Collected this month" value={rupees(invoices.data.totals.paid_this_month_paise)} tone="success" />
          </StatGrid>
        </Card>
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Tabs
          label="Invoices"
          value={show}
          onChange={(s) => setShow(s as Show)}
          items={[
            { id: "open", label: "Unpaid" },
            { id: "overdue", label: "Overdue" },
            { id: "paid", label: "Paid" },
            { id: "all", label: "All" },
          ]}
        />
        <label className="relative w-full sm:w-64">
          <span className="sr-only">Search invoices</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Customer or number" className="pl-9" maxLength={100} />
        </label>
      </div>
      <Card className="overflow-hidden p-0">
        <QueryState query={invoices} loading={<SkeletonRows rows={4} className="p-3" />}>
          {(d: Schemas["InvoicesOut"]) =>
            d.invoices.length ? (
              <ul className="divide-y divide-border" aria-label="Invoices">
                {d.invoices.map((inv) => (
                  <Row key={inv.id} inv={inv} onOpen={() => setOpen(inv)} />
                ))}
              </ul>
            ) : (
              <EmptyState
                title={show === "paid" ? "Nothing paid yet" : show === "overdue" ? "Nothing overdue" : "No invoices here"}
                description={
                  canWrite && show !== "paid" && !q ? "Add an invoice by typing it, from a photo or PDF, or from Tally." : "Try another tab or search."
                }
              />
            )
          }
        </QueryState>
      </Card>
      {gstOpen ? <GstInvoiceDialog ventureId={v.id} open onClose={() => setGstOpen(false)} /> : null}
      {open ? (
        <InvoiceDialog
          key={open === "new" ? "new" : open.id}
          ventureId={v.id}
          invoice={open === "new" ? null : open}
          open
          onClose={() => setOpen(null)}
          canWrite={canWrite}
          canAdmin={canAdmin}
        />
      ) : null}
    </div>
  );
}
