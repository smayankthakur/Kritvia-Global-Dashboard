/**
 * Backend-for-frontend proxy: /api/k/<path> -> KRITVIA_API_URL/<path>.
 *
 * - Adds `Authorization: Bearer <kv_at>` from the httpOnly cookie (never exposed to JS).
 * - On a 401 (or a missing/expired access cookie) it refreshes ONCE with kv_rt, sets the
 *   rotated cookies and retries. Concurrent refreshes of the same token are coalesced,
 *   because the API treats a reused refresh token as theft and revokes the family.
 * - Request bodies (JSON or multipart, with the original boundary) are read once so the
 *   retry can resend them; responses (including binary downloads) are streamed back.
 * - Non-GET requests must pass the Origin check (CSRF).
 * - Token-issuing auth endpoints are not reachable through the proxy: tokens would land
 *   in page JavaScript. Use /api/auth/* instead.
 */
import { ACCESS_COOKIE, REFRESH_COOKIE, clearSessionCookies, parseCookies, sessionCookies, type TokenPair } from "./cookies";
import { forbiddenOrigin, isSameOrigin } from "./origin";

export interface ProxyDeps {
  apiUrl: string;
  fetch?: typeof fetch;
  secureCookies?: boolean;
  trustedOrigins?: string[];
}

const BLOCKED = new Set(["auth/login", "auth/register", "auth/refresh", "auth/logout"]);
const FORWARD_REQUEST_HEADERS = ["content-type", "accept", "accept-language", "user-agent", "cf-connecting-ip", "x-request-id"];
const DROP_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "server",
  "date",
]);

type RefreshResult = { ok: true; tokens: TokenPair } | { ok: false; status: number };

const inflight = new Map<string, Promise<RefreshResult>>();

/** Refresh with a given refresh token at most once per ~30 s, sharing the result. */
export function refreshOnce(
  apiUrl: string,
  refreshToken: string,
  doFetch: typeof fetch,
  headers: Record<string, string> = {},
): Promise<RefreshResult> {
  const existing = inflight.get(refreshToken);
  if (existing) return existing;
  const p = (async (): Promise<RefreshResult> => {
    try {
      const res = await doFetch(`${apiUrl}/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ refresh_token: refreshToken }),
        cache: "no-store",
      });
      if (!res.ok) return { ok: false, status: res.status };
      const tokens = (await res.json()) as TokenPair;
      return { ok: true, tokens };
    } catch {
      return { ok: false, status: 502 };
    }
  })();
  inflight.set(refreshToken, p);
  const t = setTimeout(() => inflight.delete(refreshToken), 30_000);
  (t as unknown as { unref?: () => void }).unref?.();
  return p;
}

/** For tests. */
export function resetRefreshCache(): void {
  inflight.clear();
}

export function normalisePath(segments: string[]): string | null {
  if (!segments.length) return null;
  for (const s of segments) {
    if (!s || s === "." || s === ".." || s.includes("/") || s.includes("\\")) return null;
  }
  return segments.map((s) => encodeURIComponent(decodeURIComponentSafe(s))).join("/");
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function forwardHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of FORWARD_REQUEST_HEADERS) {
    const v = req.headers.get(h);
    if (v) out[h] = v;
  }
  const xff = req.headers.get("x-forwarded-for");
  if (xff) out["x-forwarded-for"] = xff;
  return out;
}

function passthrough(upstream: Response, setCookies: string[]): Response {
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!DROP_RESPONSE_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  for (const c of setCookies) headers.append("set-cookie", c);
  const body = upstream.status === 204 || upstream.status === 304 ? null : upstream.body;
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
}

function json(status: number, detail: string, setCookies: string[] = []): Response {
  const headers = new Headers({ "content-type": "application/json" });
  for (const c of setCookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify({ detail }), { status, headers });
}

export async function proxyRequest(req: Request, segments: string[], deps: ProxyDeps): Promise<Response> {
  const doFetch = deps.fetch ?? fetch;
  const method = req.method.toUpperCase();
  if (!isSameOrigin(req, deps.trustedOrigins)) return forbiddenOrigin();

  const path = normalisePath(segments);
  if (!path) return json(400, "bad path");
  if (BLOCKED.has(path)) return json(404, "not found");

  const isPublic = path === "public" || path.startsWith("public/");
  const cookies = parseCookies(req.headers.get("cookie"));
  let access = cookies[ACCESS_COOKIE];
  const refresh = cookies[REFRESH_COOKIE];
  const setCookies: string[] = [];
  const base = forwardHeaders(req);
  const refreshHeaders: Record<string, string> = {};
  if (base["user-agent"]) refreshHeaders["user-agent"] = base["user-agent"];
  if (base["cf-connecting-ip"]) refreshHeaders["cf-connecting-ip"] = base["cf-connecting-ip"];

  const body = method === "GET" || method === "HEAD" ? undefined : await req.arrayBuffer();
  const url = `${deps.apiUrl}/${path}${new URL(req.url).search}`;

  let refreshed = false;
  const doRefresh = async (): Promise<boolean> => {
    refreshed = true;
    if (!refresh) return false;
    const r = await refreshOnce(deps.apiUrl, refresh, doFetch, refreshHeaders);
    if (!r.ok) return false;
    access = r.tokens.access_token;
    setCookies.push(...sessionCookies(r.tokens, deps.secureCookies));
    return true;
  };

  if (!isPublic && !access && refresh) {
    if (!(await doRefresh())) {
      return json(401, "session expired, please sign in again", clearSessionCookies(deps.secureCookies));
    }
  }

  const send = () => {
    const headers: Record<string, string> = { ...base };
    if (!isPublic && access) headers.authorization = `Bearer ${access}`;
    return doFetch(url, { method, headers, body, redirect: "manual", cache: "no-store" });
  };

  let upstream: Response;
  try {
    upstream = await send();
  } catch {
    return json(502, "the Kritvia API is unreachable");
  }

  if (upstream.status === 401 && !isPublic && !refreshed && refresh) {
    await upstream.arrayBuffer().catch(() => undefined); // drain the small 401 body
    if (!(await doRefresh())) {
      return json(401, "session expired, please sign in again", clearSessionCookies(deps.secureCookies));
    }
    try {
      upstream = await send();
    } catch {
      return json(502, "the Kritvia API is unreachable", setCookies);
    }
  }
  return passthrough(upstream, setCookies);
}
