"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
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
  const tab = params.get("tab") === "campaigns" ? "campaigns" : "social";
  const canAdmin = Boolean(v.can_admin || v.is_owner);
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={v.venture_name}
        title="Marketing"
        description="Posts for your Google profile and Facebook Page, and campaigns to customers who agreed to hear from you. Everything goes out after your yes."
      />
      <Tabs
        label="Marketing"
        value={tab}
        onChange={(t) => router.replace(`${path}?tab=${t}`, { scroll: false })}
        items={[
          { id: "social", label: "Social posts" },
          { id: "campaigns", label: "Campaigns" },
        ]}
      />
      {tab === "social" ? <SocialTab ventureId={v.id} canAdmin={canAdmin} /> : <CampaignsTab ventureId={v.id} canAdmin={canAdmin} />}
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
