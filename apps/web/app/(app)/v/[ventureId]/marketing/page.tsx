"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { AdsTab } from "@/components/marketing/ads-tab";
import { CampaignsTab } from "@/components/marketing/campaigns-tab";
import { SocialTab } from "@/components/marketing/social-tab";
import { PageHeader } from "@/components/ui/page";
import { Tabs } from "@/components/ui/tabs";
import { useVenture } from "@/lib/venture";

function Marketing() {
  const v = useVenture();
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const raw = params.get("tab");
  const tab = raw === "campaigns" || raw === "ads" ? raw : "social";
  const canAdmin = Boolean(v.can_admin || v.is_owner);
  const canWrite = v.access === "write";
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={v.venture_name}
        title="Marketing"
        description="Posts for your Google profile and Facebook Page, campaigns to customers who agreed to hear from you, and what your ads bring in. Everything goes out after your yes."
      />
      <Tabs
        label="Marketing"
        value={tab}
        onChange={(t) => router.replace(`${path}?tab=${t}`, { scroll: false })}
        items={[
          { id: "social", label: "Social posts" },
          { id: "campaigns", label: "Campaigns" },
          { id: "ads", label: "Ads" },
        ]}
      />
      {tab === "social" ? <SocialTab ventureId={v.id} canAdmin={canAdmin} /> : null}
      {tab === "campaigns" ? <CampaignsTab ventureId={v.id} canAdmin={canAdmin} /> : null}
      {tab === "ads" ? <AdsTab ventureId={v.id} canWrite={canWrite} canAdmin={canAdmin} /> : null}
    </div>
  );
}

export default function MarketingPage() {
  return (
    <Suspense>
      <Marketing />
    </Suspense>
  );
}
