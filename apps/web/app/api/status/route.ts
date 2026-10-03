import { readFile } from "node:fs/promises";
import path from "node:path";
import { apiUrl } from "@/lib/bff/auth";
import type { Incident } from "@/lib/status";

export const dynamic = "force-dynamic";

/** Incidents recorded by the server's health watchdog (infra/scripts/healthcheck.sh), last 90 days. */
async function incidents(): Promise<Incident[]> {
  const dir = process.env.STATUS_DIR;
  if (!dir) return [];
  try {
    const raw = JSON.parse(await readFile(path.join(dir, "incidents.json"), "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((i): i is Incident => !!i && typeof i.started_at === "string" && typeof i.summary === "string")
      .map((i) => ({ started_at: i.started_at, resolved_at: typeof i.resolved_at === "string" ? i.resolved_at : null, summary: i.summary.slice(0, 200) }))
      .slice(0, 50);
  } catch {
    return [];
  }
}

/** Public status: is the API answering and is its database reachable, plus past incidents. No internal details. */
export async function GET(): Promise<Response> {
  const started = Date.now();
  const history = await incidents();
  const headers = { "cache-control": "no-store" };
  try {
    const r = await fetch(`${apiUrl()}/readyz`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    const ok = r.ok && ((await r.json()) as { status?: string }).status === "ok";
    return Response.json({ app: "operational", api: ok ? "operational" : "degraded", latency_ms: Date.now() - started, checked_at: new Date().toISOString(), incidents: history }, { headers });
  } catch {
    return Response.json({ app: "operational", api: "down", latency_ms: null, checked_at: new Date().toISOString(), incidents: history }, { headers });
  }
}
