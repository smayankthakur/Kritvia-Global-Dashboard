"use client";

import { useQueries, useQuery } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "@/lib/api";
import { useAccessQuery } from "@/lib/access";

type Connector = Schemas["ConnectorOut"];

/** A business can send email from Kritvia only through a connected, working Google account. */
export function hasMailbox(connectors: readonly Pick<Connector, "provider" | "status">[]): boolean {
  return connectors.some((c) => c.provider === "google" && c.status === "active");
}

const connectorsQuery = (ventureId: string) => ({
  queryKey: ["connectors", ventureId],
  queryFn: () => unwrap(api.GET("/ventures/{venture_id}/connectors", { params: { path: { venture_id: ventureId } } })),
  staleTime: 60_000,
  retry: false,
});

/**
 * Whether email drafts of this business can be sent (round 3, A1). undefined while unknown, or when the
 * person can't see the business's connectors: then nothing is blocked and the API has the last word.
 */
export function useCanSendEmail(ventureId: string | null | undefined, enabled = true): boolean | undefined {
  const recordedOnly = useAccessQuery().data?.email_recorded_only === true;   // local development server
  const q = useQuery({ ...connectorsQuery(ventureId ?? ""), enabled: Boolean(ventureId) && enabled && !recordedOnly });
  if (recordedOnly) return true;
  return q.data ? hasMailbox(q.data) : undefined;
}

/** The businesses, among these, known to have no mailbox to send email from. */
export function useNoMailbox(ventureIds: readonly string[]): ReadonlySet<string> {
  const recordedOnly = useAccessQuery().data?.email_recorded_only === true;
  const results = useQueries({ queries: ventureIds.map((id) => ({ ...connectorsQuery(id), enabled: !recordedOnly })) });
  const out = new Set<string>();
  if (recordedOnly) return out;
  results.forEach((r, i) => {
    if (r.data && !hasMailbox(r.data)) out.add(ventureIds[i]!);
  });
  return out;
}
