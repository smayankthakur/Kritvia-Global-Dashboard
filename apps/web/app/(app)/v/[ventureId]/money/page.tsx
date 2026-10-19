"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { BankTab } from "@/components/money/bank-tab";
import { BillsTab } from "@/components/money/bills-tab";
import { CashTab } from "@/components/money/cash-tab";
import { GstTab } from "@/components/money/gst-tab";
import { TallyTab } from "@/components/money/tally-tab";
import { PageHeader } from "@/components/ui/page";
import { Tabs } from "@/components/ui/tabs";
import { useVenture } from "@/lib/venture";

const TABS = ["cash", "bank", "bills", "gst", "tally"] as const;
type Tab = (typeof TABS)[number];

function Money() {
  const v = useVenture();
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const raw = params.get("tab");
  const tab: Tab = TABS.includes(raw as Tab) ? (raw as Tab) : "cash";
  const canWrite = v.access === "write";
  const canAdmin = Boolean(v.can_admin || v.is_owner);
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={v.venture_name}
        title="Money"
        description="The cash ahead, your bank statement matched to invoices and bills, what you owe suppliers, the month's GSTR-1, and the Tally sync. Kritvia never pays or files anything by itself."
      />
      <Tabs
        label="Money"
        value={tab}
        onChange={(t) => router.replace(`${path}?tab=${t}`, { scroll: false })}
        items={[
          { id: "cash", label: "Cash ahead" },
          { id: "bank", label: "Bank" },
          { id: "bills", label: "Bills" },
          { id: "gst", label: "GST returns" },
          { id: "tally", label: "Tally" },
        ]}
      />
      {tab === "cash" ? <CashTab ventureId={v.id} canWrite={canWrite} /> : null}
      {tab === "bank" ? <BankTab ventureId={v.id} canWrite={canWrite} canAdmin={canAdmin} /> : null}
      {tab === "bills" ? <BillsTab ventureId={v.id} canWrite={canWrite} /> : null}
      {tab === "gst" ? <GstTab ventureId={v.id} initialMonth={params.get("month")} /> : null}
      {tab === "tally" ? <TallyTab ventureId={v.id} canAdmin={canAdmin} /> : null}
    </div>
  );
}

export default function MoneyPage() {
  return (
    <Suspense>
      <Money />
    </Suspense>
  );
}
