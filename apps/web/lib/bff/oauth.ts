/**
 * Google OAuth (and "Add to Slack", the same way), bound to the browser that started it.
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
import { CSRF_HEADER, csrfOk, csrfRefused, newCsrfToken } from "./csrf";
import { forbiddenOrigin, isSameOrigin, requestHost } from "./origin";
import { parseCookies, serializeCookie, sessionCookies, type TokenPair } from "./cookies";
import { proxyRequest, type ProxyDeps } from "./proxy";

export const OAUTH_COOKIE = "kv_oauth";
/** Nonce for "Sign in with Google" (no session yet). Same path and redirect URI as connectors. */
export const SIGNIN_COOKIE = "kv_signin";
/** Nonce for "Sign in with SSO" (an organisation's own identity provider). */
export const SSO_COOKIE = "kv_sso";
const COOKIE_PATH = "/api/oauth";

function randomNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Build an internal same-origin request so proxyRequest adds auth, refreshes and passes the CSRF check. */
/** The origin the browser used. Behind a tunnel or reverse proxy req.url carries the internal
 * address (e.g. http://0.0.0.0:3000), which must never reach a redirect or an Origin header. */
export function publicOrigin(req: Request): string {
  const fwd = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const proto = fwd === "http" || fwd === "https" ? fwd : new URL(req.url).protocol.replace(":", "");
  return `${proto}://${requestHost(req)}`;
}

function innerRequest(req: Request, method: string, body: unknown): Request {
  const origin = publicOrigin(req);
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
  // We build this request ourselves after checking the browser's, so it carries its own token.
  const token = newCsrfToken();
  headers.set(CSRF_HEADER, token);
  const others = (headers.get("cookie") ?? "")
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c && !/^(__Host-)?kv_csrf=/.test(c));
  headers.set("cookie", [...others, `kv_csrf=${token}`].join("; "));
  return new Request(req.url, { method, headers, body: JSON.stringify(body) });
}

function setCookiesOf(res: Response): string[] {
  const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
  return anyHeaders.getSetCookie?.() ?? [];
}

/** Connectors that use this flow, with the API route that returns each one's consent URL. */
const START_PATH: Record<ConnectorProvider, string> = { google: "start", slack: "install" };
export type ConnectorProvider = "google" | "slack";

export async function startGoogle(req: Request, deps: ProxyDeps): Promise<Response> {
  return startConnector(req, deps, "google");
}

/** "Add to Slack" (Kritvia's Slack app), bound to this browser the same way as Google. */
export async function startSlack(req: Request, deps: ProxyDeps): Promise<Response> {
  return startConnector(req, deps, "slack");
}

async function startConnector(
  req: Request,
  deps: ProxyDeps,
  provider: ConnectorProvider,
): Promise<Response> {
  // CSRF: the browser's own request must be same-origin and carry the token; the inner request is built by us.
  if (!isSameOrigin(req, deps.trustedOrigins)) return forbiddenOrigin();
  if (!csrfOk(req)) return csrfRefused(req);
  let ventureId = "";
  let businessProfile = false;
  try {
    const b = (await req.json()) as { venture_id?: string; business_profile?: boolean };
    ventureId = String(b.venture_id ?? "");
    businessProfile = provider === "google" && b.business_profile === true;
  } catch {
    /* handled below */
  }
  if (!/^[0-9a-f-]{36}$/i.test(ventureId)) {
    return Response.json({ detail: "venture_id is required" }, { status: 422 });
  }
  const nonce = randomNonce();
  const upstream = await proxyRequest(
    innerRequest(req, "POST", businessProfile ? { nonce, business_profile: true } : { nonce }),
    ["ventures", ventureId, "connectors", provider, START_PATH[provider]],
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
  let target = new URL("/login", publicOrigin(req));
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
      target = new URL("/", publicOrigin(req));
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
  return completeConnector(req, deps, "google");
}

export async function completeSlack(req: Request, deps: ProxyDeps): Promise<Response> {
  return completeConnector(req, deps, "slack");
}

async function completeConnector(req: Request, deps: ProxyDeps, provider: ConnectorProvider): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const nonce = parseCookies(req.headers.get("cookie"))[OAUTH_COOKIE];
  const back = new URL("/settings/connectors", publicOrigin(req));
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
      ["connectors", provider, "complete"],
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
  back.searchParams.set(provider, outcome);
  headers.set("location", back.toString());
  return new Response(null, { status: 303, headers });
}

/** "Sign in with SSO": POST /api/oauth/sso/start {email} -> the organisation's identity provider. */
export async function startSsoSignin(req: Request, deps: ProxyDeps): Promise<Response> {
  if (!isSameOrigin(req, deps.trustedOrigins)) return forbiddenOrigin();
  let email = "";
  try {
    email = String(((await req.json()) as { email?: string }).email ?? "").trim();
  } catch {
    /* handled below */
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return Response.json({ detail: "enter your work email" }, { status: 422 });
  }
  const nonce = randomNonce();
  let upstream: Response;
  try {
    upstream = await (deps.fetch ?? fetch)(`${deps.apiUrl}/auth/sso/start`, {
      method: "POST",
      headers: clientHeaders(req),
      body: JSON.stringify({ email, nonce }),
      cache: "no-store",
    });
  } catch {
    return Response.json({ detail: "the Kritvia API is unreachable" }, { status: 502 });
  }
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  if (upstream.ok) {
    headers.append(
      "set-cookie",
      serializeCookie(SSO_COOKIE, nonce, { httpOnly: true, secure: deps.secureCookies, sameSite: "Lax", maxAge: 600, path: COOKIE_PATH }),
    );
  }
  return new Response(await upstream.text(), { status: upstream.status, headers });
}

/** GET /api/oauth/sso/callback?code&state: the redirect URI each organisation registers with its provider. */
export async function completeSso(req: Request, deps: ProxyDeps): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const nonce = parseCookies(req.headers.get("cookie"))[SSO_COOKIE];
  const headers = new Headers({ "cache-control": "no-store" });
  headers.append("set-cookie", serializeCookie(SSO_COOKIE, "", { httpOnly: true, secure: deps.secureCookies, maxAge: 0, path: COOKIE_PATH }));
  let target = new URL("/login", publicOrigin(req));
  if (url.searchParams.get("error") || !code || !state) {
    target.searchParams.set("sso", "denied");
  } else if (!nonce || stateType(state) !== "sso") {
    target.searchParams.set("sso", "invalid_state");
  } else {
    let res: Response | null = null;
    try {
      res = await (deps.fetch ?? fetch)(`${deps.apiUrl}/auth/sso/complete`, {
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
      target = new URL("/", publicOrigin(req));
    } else {
      let detail = "";
      try {
        detail = String(((await res?.json()) as { detail?: string } | undefined)?.detail ?? "");
      } catch {
        detail = "";
      }
      target.searchParams.set(
        "sso",
        res?.status === 400 ? "invalid_state" : res?.status === 403 && /invite/.test(detail) ? "no_account" : res?.status === 403 ? "forbidden" : "failed",
      );
    }
  }
  headers.set("location", target.toString());
  return new Response(null, { status: 303, headers });
}

/**
 * Sign in to an app from the App store (MCP OAuth), bound to this browser like Google.
 * start:    POST /api/oauth/mcp/start {venture_id, name, url, catalog_id?}
 *           -> nonce cookie (kv_oauth) -> API /ventures/{v}/apps/oauth/start {nonce, …} -> the app's sign-in address
 * callback: GET /api/oauth/mcp/callback?code&state&iss -> API /apps/oauth/complete {code, state, iss, nonce}
 *           -> back to /v/<venture>/apps?app=connected|denied|invalid_state|forbidden|exchange_failed
 */
export async function startMcp(req: Request, deps: ProxyDeps): Promise<Response> {
  if (!isSameOrigin(req, deps.trustedOrigins)) return forbiddenOrigin();
  if (!csrfOk(req)) return csrfRefused(req);
  let b: { venture_id?: string; name?: string; url?: string; catalog_id?: string | null } = {};
  try {
    b = (await req.json()) as typeof b;
  } catch {
    /* handled below */
  }
  const ventureId = String(b.venture_id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(ventureId)) {
    return Response.json({ detail: "venture_id is required" }, { status: 422 });
  }
  const nonce = randomNonce();
  const upstream = await proxyRequest(
    innerRequest(req, "POST", { name: b.name ?? "", url: b.url ?? "", catalog_id: b.catalog_id ?? null, nonce }),
    ["ventures", ventureId, "apps", "oauth", "start"],
    deps,
  );
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const c of setCookiesOf(upstream)) headers.append("set-cookie", c);
  if (upstream.ok) {
    headers.append(
      "set-cookie",
      serializeCookie(OAUTH_COOKIE, nonce, { httpOnly: true, secure: deps.secureCookies, sameSite: "Lax", maxAge: 900, path: COOKIE_PATH }),
    );
  }
  return new Response(await upstream.text(), { status: upstream.status, headers });
}

export async function completeMcp(req: Request, deps: ProxyDeps): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const iss = url.searchParams.get("iss");
  const nonce = parseCookies(req.headers.get("cookie"))[OAUTH_COOKIE];
  const headers = new Headers({ "cache-control": "no-store" });
  headers.append("set-cookie", serializeCookie(OAUTH_COOKIE, "", { httpOnly: true, secure: deps.secureCookies, maxAge: 0, path: COOKIE_PATH }));
  let back = new URL("/", publicOrigin(req));
  let outcome = "denied";
  if (url.searchParams.get("error") || !code || !state) {
    outcome = "denied";
  } else if (!nonce) {
    outcome = "invalid_state";
  } else {
    const upstream = await proxyRequest(innerRequest(req, "POST", { code, state, iss, nonce }), ["apps", "oauth", "complete"], deps);
    for (const c of setCookiesOf(upstream)) headers.append("set-cookie", c);
    if (upstream.ok) {
      const out = (await upstream.json()) as { venture_id: string; app: { name: string } };
      outcome = "connected";
      back = new URL(`/v/${out.venture_id}/apps`, publicOrigin(req));
      back.searchParams.set("name", out.app.name);
    } else {
      outcome = upstream.status === 400 ? "invalid_state" : upstream.status === 403 || upstream.status === 404 ? "forbidden" : "exchange_failed";
    }
  }
  back.searchParams.set("app", outcome);
  headers.set("location", back.toString());
  return new Response(null, { status: 303, headers });
}
