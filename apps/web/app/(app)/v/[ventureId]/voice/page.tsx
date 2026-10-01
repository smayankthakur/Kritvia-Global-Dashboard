"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { VoiceInsights } from "@/components/voice/insights";
import { VocabularyManager } from "@/components/voice/vocabulary";
import { VoiceSettingsPanel } from "@/components/voice/voice-settings";
import { PageHeader } from "@/components/ui/page";
import { Tabs } from "@/components/ui/tabs";
import { useVenture } from "@/lib/venture";

const TABS = [
  { id: "insights", label: "Insights" },
  { id: "vocabulary", label: "Vocabulary" },
  { id: "settings", label: "Settings" },
] as const;

function VoiceView() {
  const v = useVenture();
  const router = useRouter();
  const params = useSearchParams();
  const tab = TABS.find((t) => t.id === params.get("tab"))?.id ?? "insights";
  return (
    <>
      <PageHeader
        eyebrow={v.venture_name}
        title="Voice"
        description="Dictate anywhere in Kritvia, teach it your names and terms, and see how much typing it saves you."
      />
      <Tabs
        label="Voice"
        items={TABS.map((t) => ({ id: t.id, label: t.label }))}
        value={tab}
        onChange={(id) => router.replace(`/v/${v.id}/voice?tab=${id}`, { scroll: false })}
        className="mb-4"
      />
      {tab === "insights" ? <VoiceInsights ventureId={v.id} /> : null}
      {tab === "vocabulary" ? <VocabularyManager ventureId={v.id} canWrite={v.access === "write"} /> : null}
      {tab === "settings" ? <VoiceSettingsPanel /> : null}
    </>
  );
}

export default function VoicePage() {
  return (
    <Suspense>
      <VoiceView />
    </Suspense>
  );
}
