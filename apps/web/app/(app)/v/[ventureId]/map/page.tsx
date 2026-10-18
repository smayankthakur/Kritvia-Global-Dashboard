"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { MindMap } from "@/components/knowledge/mind-map";
import { TeamMap } from "@/components/knowledge/team-map";
import { PageHeader } from "@/components/ui/page";
import { Tabs } from "@/components/ui/tabs";
import { useVenture } from "@/lib/venture";

function Views() {
  const v = useVenture();
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const tab = params.get("view") === "people" ? "people" : "knowledge";
  return (
    <>
      <PageHeader
        eyebrow={v.venture_name}
        title="Mind map"
        description={
          tab === "people"
            ? "Who works with whom: on which projects, in which teams, and why each link is there."
            : "The people, companies, deals and documents Kritvia has learned about, and how they connect. Every link has a source."
        }
      />
      <Tabs
        label="Mind map views"
        className="mb-4"
        value={tab}
        onChange={(id) => router.replace(id === "people" ? `${path}?view=people` : path, { scroll: false })}
        items={[
          { id: "knowledge", label: "Knowledge" },
          { id: "people", label: "People & projects" },
        ]}
      />
      {tab === "people" ? <TeamMap ventureId={v.id} /> : <MindMap ventureId={v.id} />}
    </>
  );
}

export default function MindMapPage() {
  return (
    <Suspense>
      <Views />
    </Suspense>
  );
}
