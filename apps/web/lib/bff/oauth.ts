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
 *
 * Sign in with Google uses the same redirect URI: start sets kv_signin instead, and the
 * callback tells the two apart by the state's "typ" claim (the API verifies the state).
 */
import { forbiddenOrigin, isSameOrigin } from "./origin";
import { parseCookies, serializeCookie, sessionCookies, type TokenPair } from "./cookies";
import { proxyRequest, type ProxyDeps } from "./proxy";

export const OAUTH_COOKIE = "kv_oauth";
/** Nonce for "Sign in with Google" (no session yet). Same path and redirect URI as connectors. */
export const SIGNIN_COOKIE = "kv_signin";
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

function clientHeaders(req: Request): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  for (const k of ["user-agent", "cf-connecting-ip", "x-forwarded-for"]) {
    const v = req.headers.get(k);
    if (v) h[k] = v;
  }
  return h;
}

/** The unverified "typ" claim of a state JWT, only to route the callback. */
export function stateType(state: string | null): string | null {
  const part = state?.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const typ = (JSON.parse(atob(b64)) as { typ?: unknown }).typ;
    return typeof typ === "string" ? typ : null;
  } catch {
    return null;
  }
}

export async function startGoogleSignin(req: Request, deps: ProxyDeps): Promise<Response> {
  if (!isSameOrigin(req, deps.trustedOrigins)) return forbiddenOrigin();
  const doFetch = deps.fetch ?? fetch;
  const nonce = randomNonce();
  let upstream: Response;
  try {
    upstream = await doFetch(`${deps.apiUrl}/auth/google/start`, {
      method: "POST",
      headers: clientHeaders(req),
      body: JSON.stringify({ nonce }),
      cache: "no-store",
    });
  } catch {
    return Response.json({ detail: "the Kritvia API is unreachable" }, { status: 502 });
  }
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  if (upstream.ok) {
    headers.append(
      "set-cookie",
      serializeCookie(SIGNIN_COOKIE, nonce, {
        httpOnly: true,
        secure: deps.secureCookies,
        sameSite: "Lax",
        maxAge: 600,
        path: COOKIE_PATH,
      }),
    );
  }
  return new Response(await upstream.text(), { status: upstream.status, headers });
}

async function completeSignin(req: Request, deps: ProxyDeps, code: string | null, state: string | null): Promise<Response> {
  const url = new URL(req.url);
  const nonce = parseCookies(req.headers.get("cookie"))[SIGNIN_COOKIE];
  const headers = new Headers({ "cache-control": "no-store" });
  headers.append(
    "set-cookie",
    serializeCookie(SIGNIN_COOKIE, "", { httpOnly: true, secure: deps.secureCookies, maxAge: 0, path: COOKIE_PATH }),
  );
  let target = new URL("/login", url.origin);
  if (url.searchParams.get("error") || !code || !state) {
    target.searchParams.set("google", "denied");
  } else if (!nonce) {
    target.searchParams.set("google", "invalid_state");
  } else {
    let res: Response | null = null;
    try {
      res = await (deps.fetch ?? fetch)(`${deps.apiUrl}/auth/google/complete`, {
        method: "POST",
        headers: clientHeaders(req),
        body: JSON.stringify({ code, state, nonce }),
        cache: "no-store",
      });
    } catch {
      res = null;
    }
    if (res?.ok) {
      const tokens = (await res.json()) as TokenPair;
      for (const c of sessionCookies(tokens, deps.secureCookies)) headers.append("set-cookie", c);
      target = new URL("/", url.origin);
    } else {
      target.searchParams.set(
        "google",
        res?.status === 400 ? "invalid_state" : res?.status === 403 ? "forbidden" : "failed",
      );
    }
  }
  headers.set("location", target.toString());
  return new Response(null, { status: 303, headers });
}

export async function completeGoogle(
  req: Request,
  deps: ProxyDeps,
): Promise<Response> {
  const url = new URL(req.url);
  if (stateType(url.searchParams.get("state")) === "signin") {
    return completeSignin(req, deps, url.searchParams.get("code"), url.searchParams.get("state"));
  }
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
