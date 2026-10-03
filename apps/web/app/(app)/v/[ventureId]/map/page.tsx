"use client";

import { MindMap } from "@/components/knowledge/mind-map";
import { PageHeader } from "@/components/ui/page";
import { useVenture } from "@/lib/venture";

export default function MindMapPage() {
  const v = useVenture();
  return (
    <>
      <PageHeader
        eyebrow={v.venture_name}
        title="Mind map"
        description="The people, companies, deals and documents Kritvia has learned about, and how they connect. Every link has a source."
      />
      <MindMap ventureId={v.id} />
    </>
  );
}
