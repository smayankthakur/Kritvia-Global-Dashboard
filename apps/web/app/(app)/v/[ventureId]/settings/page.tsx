"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { ConnectorSettings } from "@/components/settings/connectors";
import { GeneralSettings } from "@/components/settings/general";
import { MemberSettings } from "@/components/settings/members";
import { ModelSettings } from "@/components/settings/models";
import { WorkflowSettings } from "@/components/settings/workflows";
import { PageHeader } from "@/components/ui/page";
import { Tabs } from "@/components/ui/tabs";
import { useVenture } from "@/lib/venture";

const TABS = [
  { id: "general", label: "General" },
  { id: "workflows", label: "Workflows" },
  { id: "connectors", label: "Connectors" },
  { id: "members", label: "Members & access" },
  { id: "models", label: "Models & usage" },
] as const;

function SettingsView() {
  const v = useVenture();
  const router = useRouter();
  const params = useSearchParams();
  const tab = TABS.find((t) => t.id === params.get("tab"))?.id ?? "general";
  const canAdmin = v.can_admin || v.is_owner;
  return (
    <>
      <PageHeader eyebrow={v.venture_name} title="Settings" description="Venture configuration, workflows, connectors, people and models." />
      <Tabs
        label="Settings"
        items={TABS.map((t) => ({ id: t.id, label: t.label }))}
        value={tab}
        onChange={(id) => router.replace(`/v/${v.id}/settings?tab=${id}`, { scroll: false })}
        className="mb-4"
      />
      {tab === "general" ? <GeneralSettings ventureId={v.id} canAdmin={canAdmin} /> : null}
      {tab === "workflows" ? <WorkflowSettings ventureId={v.id} kind={v.kind} canAdmin={canAdmin} /> : null}
      {tab === "connectors" ? <ConnectorSettings ventureId={v.id} canAdmin={canAdmin} /> : null}
      {tab === "members" ? <MemberSettings ventureId={v.id} /> : null}
      {tab === "models" ? <ModelSettings ventureId={v.id} /> : null}
    </>
  );
}

export default function SettingsPage() {
  return (
    <Suspense>
      <SettingsView />
    </Suspense>
  );
}
