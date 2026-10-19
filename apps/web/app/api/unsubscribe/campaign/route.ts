import { apiUrl } from "@/lib/bff/auth";

export const dynamic = "force-dynamic";

/**
 * Unsubscribe from one business's campaign emails. The signed token in the link (?t=) is the authorisation,
 * so there is no sign-in and no same-origin check; mail apps may POST here from their own servers.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  let token = url.searchParams.get("t") ?? "";
  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      token = ((await req.json()) as { token?: string }).token ?? token;
    } catch {
      return Response.json({ detail: "invalid request" }, { status: 400 });
    }
  }
  if (!/^[A-Za-z0-9_-]{40,500}$/.test(token)) return Response.json({ detail: "this unsubscribe link is not valid" }, { status: 400 });
  try {
    const r = await fetch(`${apiUrl()}/public/campaign-unsubscribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
      cache: "no-store",
    });
    return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch {
    return Response.json({ detail: "the Kritvia API is unreachable" }, { status: 502 });
  }
}
