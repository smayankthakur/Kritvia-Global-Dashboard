"use client";

import { useRouteVenture, type Access } from "./access";

/** The venture of the current /v/[ventureId] page. The venture layout guarantees it exists. */
export function useVenture(): Access & { id: string } {
  const v = useRouteVenture();
  if (!v) throw new Error("useVenture() used outside a visible /v/[ventureId] route");
  return { ...v, id: v.venture_id };
}
