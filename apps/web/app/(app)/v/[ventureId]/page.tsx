"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { SkeletonRows } from "@/components/ui/states";
import { kindOf } from "@/lib/access";
import { ventureNav } from "@/lib/nav";
import { useVenture } from "@/lib/venture";

/** /v/<business> on its own (a trimmed address, a shared link): open the business's first page instead of a 404. */
export default function VentureHome() {
  const v = useVenture();
  const router = useRouter();
  const home = businessHome(v.id, kindOf(v));
  useEffect(() => router.replace(home), [router, home]);
  return <SkeletonRows rows={3} />;
}

function businessHome(id: string, kind: ReturnType<typeof kindOf>): string {
  return ventureNav(id, kind).domain[0]?.href ?? `/v/${id}/assistant`;
}
