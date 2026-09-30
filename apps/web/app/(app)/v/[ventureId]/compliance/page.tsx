"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Breaches } from "@/components/compliance/breaches";
import { Consents } from "@/components/compliance/consents";
import { DpdpRequests } from "@/components/compliance/dpdp";
import { Retention } from "@/components/compliance/retention";
import { PageHeader } from "@/components/ui/page";
import { Tabs } from "@/components/ui/tabs";
import { useVenture } from "@/lib/venture";

const TABS = [
  { id: "consents", label: "Consents" },
  { id: "requests", label: "Data requests" },
  { id: "retention", label: "Retention" },
  { id: "breaches", label: "Breaches" },
] as const;

function ComplianceView() {
  const v = useVenture();
  const router = useRouter();
  const params = useSearchParams();
  const tab = TABS.find((t) => t.id === params.get("tab"))?.id ?? "consents";
  const canAdmin = v.can_admin || v.is_owner;
  return (
    <>
      <PageHeader
        eyebrow={v.venture_name}
        title="Compliance"
        description="DPDP Act foundations: consent records, data principal requests with due dates, retention and the breach register. Every action is audited."
      />
      <Tabs
        label="Compliance"
        items={TABS.map((t) => ({ id: t.id, label: t.label }))}
        value={tab}
        onChange={(id) => router.replace(`/v/${v.id}/compliance?tab=${id}`, { scroll: false })}
        className="mb-4"
      />
      {tab === "consents" ? <Consents ventureId={v.id} /> : null}
      {tab === "requests" ? <DpdpRequests ventureId={v.id} canAdmin={canAdmin} /> : null}
      {tab === "retention" ? <Retention ventureId={v.id} canAdmin={canAdmin} /> : null}
      {tab === "breaches" ? <Breaches ventureId={v.id} canAdmin={canAdmin} /> : null}
    </>
  );
}

export default function CompliancePage() {
  return (
    <Suspense>
      <ComplianceView />
    </Suspense>
  );
}
