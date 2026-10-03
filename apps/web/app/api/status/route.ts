import { apiUrl } from "@/lib/bff/auth";

export const dynamic = "force-dynamic";

/** Public status: is the API answering and is its database reachable. No details beyond that. */
export async function GET(): Promise<Response> {
  const started = Date.now();
  try {
    const r = await fetch(`${apiUrl()}/readyz`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    const ok = r.ok && ((await r.json()) as { status?: string }).status === "ok";
    return Response.json({ app: "operational", api: ok ? "operational" : "degraded", latency_ms: Date.now() - started, checked_at: new Date().toISOString() }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ app: "operational", api: "down", latency_ms: null, checked_at: new Date().toISOString() }, { headers: { "cache-control": "no-store" } });
  }
}
