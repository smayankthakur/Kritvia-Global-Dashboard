import { apiUrl } from "@/lib/bff/auth";

export const dynamic = "force-dynamic";

/**
 * One-click unsubscribe from product emails (RFC 8058). Mail apps POST
 * "List-Unsubscribe=One-Click" here from their own servers, so there is no same-origin check:
 * the signed token in ?t= is the authorisation, and the action is harmless and reversible.
 * The /unsubscribe page posts JSON here too ({ resubscribe } to undo).
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  let token = url.searchParams.get("t") ?? "";
  let resubscribe = false;
  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      const b = (await req.json()) as { token?: string; resubscribe?: boolean };
      token = b.token ?? token;
      resubscribe = b.resubscribe === true;
    } catch {
      return Response.json({ detail: "invalid request" }, { status: 400 });
    }
  }
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) return Response.json({ detail: "this unsubscribe link is not valid" }, { status: 400 });
  try {
    const r = await fetch(`${apiUrl()}/public/unsubscribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, resubscribe }),
      cache: "no-store",
    });
    return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch {
    return Response.json({ detail: "the Kritvia API is unreachable" }, { status: 502 });
  }
}

/** A person who clicks the header link in a browser gets the page that explains and confirms. */
export function GET(req: Request) {
  const url = new URL(req.url);
  const to = new URL("/unsubscribe", url);
  const t = url.searchParams.get("t");
  if (t) to.searchParams.set("t", t);
  return Response.redirect(to, 303);
}
