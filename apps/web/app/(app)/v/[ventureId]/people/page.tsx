"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { AttendanceTab } from "@/components/people/attendance-tab";
import { HiringTab } from "@/components/people/hiring-tab";
import { PageHeader } from "@/components/ui/page";
import { Tabs } from "@/components/ui/tabs";
import { useVenture } from "@/lib/venture";

function People() {
  const v = useVenture();
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const tab = params.get("tab") === "attendance" ? "attendance" : "hiring";
  const canWrite = v.access === "write";
  const canAdmin = Boolean(v.can_admin || v.is_owner);
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={v.venture_name}
        title="People"
        description="Hiring: every CV scored against the role, interview invites after your yes. Attendance: the team checks in on WhatsApp, and the month adds up for salaries."
      />
      <Tabs
        label="People"
        value={tab}
        onChange={(t) => router.replace(`${path}?tab=${t}`, { scroll: false })}
        items={[
          { id: "hiring", label: "Hiring" },
          { id: "attendance", label: "Attendance" },
        ]}
      />
      {tab === "hiring" ? <HiringTab ventureId={v.id} canWrite={canWrite} canAdmin={canAdmin} /> : <AttendanceTab ventureId={v.id} canWrite={canWrite} canAdmin={canAdmin} />}
    </div>
  );
}

export default function PeoplePage() {
  return (
    <Suspense>
      <People />
    </Suspense>
  );
}
