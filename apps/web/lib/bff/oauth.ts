/**
 * Google OAuth, bound to the browser that started it.
 *
 * start:    POST /api/oauth/google/start {venture_id}
 *           -> random nonce in an httpOnly cookie (kv_oauth, path /api/oauth, 10 min)
 *           -> API /ventures/{v}/connectors/google/start {nonce} returns Google's consent URL
 * callback: GET  /api/oauth/google/callback?code&state   (the redirect URI registered with Google)
 *           -> API /connectors/google/complete {code, state, nonce-from-cookie} as the signed-in user
 *
 * A consent link started by someone else fails: this browser has no matching nonce
 * cookie and is not signed in as the user who started it.
 */
import { parseCookies, serializeCookie } from "./cookies";
import { proxyRequest, type ProxyDeps } from "./proxy";

export const OAUTH_COOKIE = "kv_oauth";
const COOKIE_PATH = "/api/oauth";

function randomNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Build an internal same-origin request so proxyRequest adds auth, refreshes and passes the CSRF check. */
function innerRequest(req: Request, method: string, body: unknown): Request {
  const origin = new URL(req.url).origin;
  const headers = new Headers({ "content-type": "application/json", origin });
  for (const h of [
    "cookie",
    "host",
    "user-agent",
    "cf-connecting-ip",
    "x-forwarded-host",
    "x-forwarded-proto",
  ]) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Request(req.url, { method, headers, body: JSON.stringify(body) });
}

function setCookiesOf(res: Response): string[] {
  const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
  return anyHeaders.getSetCookie?.() ?? [];
}

export async function startGoogle(
  req: Request,
  deps: ProxyDeps,
): Promise<Response> {
  let ventureId = "";
  try {
    ventureId = String(
      ((await req.json()) as { venture_id?: string }).venture_id ?? "",
    );
  } catch {
    /* handled below */
  }
  if (!/^[0-9a-f-]{36}$/i.test(ventureId)) {
    return Response.json({ detail: "venture_id is required" }, { status: 422 });
  }
  const nonce = randomNonce();
  const upstream = await proxyRequest(
    innerRequest(req, "POST", { nonce }),
    ["ventures", ventureId, "connectors", "google", "start"],
    deps,
  );
  const headers = new Headers({
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  for (const c of setCookiesOf(upstream)) headers.append("set-cookie", c);
  const text = await upstream.text();
  if (upstream.ok) {
    headers.append(
      "set-cookie",
      serializeCookie(OAUTH_COOKIE, nonce, {
        httpOnly: true,
        secure: deps.secureCookies,
        sameSite: "Lax",
        maxAge: 600,
        path: COOKIE_PATH,
      }),
    );
  }
  return new Response(text, { status: upstream.status, headers });
}

export async function completeGoogle(
  req: Request,
  deps: ProxyDeps,
): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const nonce = parseCookies(req.headers.get("cookie"))[OAUTH_COOKIE];
  const back = new URL("/settings/connectors", url.origin);
  const headers = new Headers({ "cache-control": "no-store" });
  headers.append(
    "set-cookie",
    serializeCookie(OAUTH_COOKIE, "", {
      httpOnly: true,
      secure: deps.secureCookies,
      maxAge: 0,
      path: COOKIE_PATH,
    }),
  );

  let outcome = "denied";
  if (url.searchParams.get("error") || !code || !state) {
    outcome = "denied";
  } else if (!nonce) {
    outcome = "invalid_state";
  } else {
    const upstream = await proxyRequest(
      innerRequest(req, "POST", { code, state, nonce }),
      ["connectors", "google", "complete"],
      deps,
    );
    for (const c of setCookiesOf(upstream)) headers.append("set-cookie", c);
    if (upstream.ok) {
      const out = (await upstream.json()) as { venture_id: string };
      outcome = "connected";
      back.searchParams.set("venture", out.venture_id);
    } else {
      outcome =
        upstream.status === 400
          ? "invalid_state"
          : upstream.status === 403 || upstream.status === 404
            ? "forbidden"
            : "exchange_failed";
    }
  }
  back.searchParams.set("google", outcome);
  headers.set("location", back.toString());
  return new Response(null, { status: 303, headers });
}
