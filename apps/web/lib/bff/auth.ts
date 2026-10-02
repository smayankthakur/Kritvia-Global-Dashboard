import { REFRESH_COOKIE, clearSessionCookies, parseCookies, sessionCookies, type TokenPair } from "./cookies";
import { forbiddenOrigin, isSameOrigin } from "./origin";

export function apiUrl(): string {
  return (process.env.KRITVIA_API_URL ?? "http://localhost:8000").replace(/\/+$/, "");
}

function clientHeaders(req: Request): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  for (const k of ["user-agent", "cf-connecting-ip", "x-forwarded-for"]) {
    const v = req.headers.get(k);
    if (v) h[k] = v;
  }
  return h;
}

/** Exchange credentials with the API and turn the token pair into httpOnly cookies.
 * The browser only ever receives `{ ok: true }`. */
export type CredentialEndpoint = "login" | "register" | "email/verify";

export async function exchangeCredentials(
  req: Request,
  endpoint: CredentialEndpoint,
  doFetch: typeof fetch = fetch,
): Promise<Response> {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ detail: "invalid JSON body" }, { status: 400 });
  }
  let res: Response;
  try {
    res = await doFetch(`${apiUrl()}/auth/${endpoint}`, {
      method: "POST",
      headers: clientHeaders(req),
      body: JSON.stringify(payload),
      cache: "no-store",
    });
  } catch {
    return Response.json({ detail: "the Kritvia API is unreachable" }, { status: 502 });
  }
  if (!res.ok) {
    const headers = new Headers({ "content-type": "application/json" });
    const retry = res.headers.get("retry-after");
    if (retry) headers.set("retry-after", retry);
    return new Response(await res.text(), { status: res.status, headers });
  }
  const tokens = (await res.json()) as TokenPair;
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const c of sessionCookies(tokens)) headers.append("set-cookie", c);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

export async function logout(req: Request, doFetch: typeof fetch = fetch): Promise<Response> {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const rt = parseCookies(req.headers.get("cookie"))[REFRESH_COOKIE];
  if (rt) {
    try {
      await doFetch(`${apiUrl()}/auth/logout`, {
        method: "POST",
        headers: clientHeaders(req),
        body: JSON.stringify({ refresh_token: rt }),
        cache: "no-store",
      });
    } catch {
      // Revocation is best-effort; the cookies are cleared regardless.
    }
  }
  const headers = new Headers({ "content-type": "application/json" });
  for (const c of clearSessionCookies()) headers.append("set-cookie", c);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

/** Forward an anonymous, token-free auth call (e.g. "send me a code") to the API. */
export async function forwardAnonymous(
  req: Request,
  path: string,
  doFetch: typeof fetch = fetch,
): Promise<Response> {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  let res: Response;
  try {
    res = await doFetch(`${apiUrl()}/${path}`, {
      method: "POST",
      headers: clientHeaders(req),
      body: await req.text(),
      cache: "no-store",
    });
  } catch {
    return Response.json({ detail: "the Kritvia API is unreachable" }, { status: 502 });
  }
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  const retry = res.headers.get("retry-after");
  if (retry) headers.set("retry-after", retry);
  return new Response(await res.text(), { status: res.status, headers });
}
