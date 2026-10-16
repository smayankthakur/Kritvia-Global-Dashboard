/**
 * QR sign-in between devices (API: routers/device_link.py). The device that wants to be signed in
 * gets a secret from the API; this BFF keeps it in the httpOnly `kv_link` cookie (path-limited to
 * these routes, 5 minutes) and adds it when redeeming, so page JavaScript never sees it. A redeemed
 * link becomes the usual httpOnly session cookies, exactly like a password sign-in.
 */
import { apiUrl } from "./auth";
import { LINK_COOKIE, cookieSecure, parseCookies, serializeCookie, sessionCookies, type TokenPair } from "./cookies";
import { forbiddenOrigin, isSameOrigin } from "./origin";

const PATH = "/api/auth/link";
const MAX_AGE = 5 * 60;

function headersFor(req: Request): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  for (const k of ["user-agent", "cf-connecting-ip", "x-forwarded-for"]) {
    const v = req.headers.get(k);
    if (v) h[k] = v;
  }
  return h;
}

function linkCookie(value: string, secure = cookieSecure()): string {
  return serializeCookie(LINK_COOKIE, value, { httpOnly: true, secure, sameSite: "Lax", path: PATH, maxAge: value ? MAX_AGE : 0 });
}

async function call(req: Request, path: string, body: unknown, doFetch: typeof fetch): Promise<Response | null> {
  try {
    return await doFetch(`${apiUrl()}/auth/link/${path}`, {
      method: "POST",
      headers: headersFor(req),
      body: JSON.stringify(body ?? {}),
      cache: "no-store",
    });
  } catch {
    return null;
  }
}

const unreachable = () => Response.json({ detail: "the Kritvia API is unreachable" }, { status: 502 });

function passThrough(res: Response, text: string, extra: string[] = []): Response {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  const retry = res.headers.get("retry-after");
  if (retry) headers.set("retry-after", retry);
  for (const c of extra) headers.append("set-cookie", c);
  return new Response(text, { status: res.status, headers });
}

async function tokenFrom(req: Request): Promise<string | null> {
  try {
    const b = (await req.json()) as { token?: unknown };
    return typeof b.token === "string" && /^[A-Za-z0-9_-]{32,64}$/.test(b.token) ? b.token : null;
  } catch {
    return null;
  }
}

/** Login page: "Sign in with your phone". Returns the QR's contents; keeps the secret. */
export async function startRequest(req: Request, doFetch: typeof fetch = fetch): Promise<Response> {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const res = await call(req, "request", {}, doFetch);
  if (!res) return unreachable();
  const text = await res.text();
  if (!res.ok) return passThrough(res, text);
  const r = JSON.parse(text) as { token: string; secret: string; url: string; expires_at: string };
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  headers.append("set-cookie", linkCookie(r.secret));
  return new Response(JSON.stringify({ token: r.token, url: r.url, expires_at: r.expires_at }), { status: 201, headers });
}

/** A new device scanned a computer's QR code. */
export async function claimOffer(req: Request, doFetch: typeof fetch = fetch): Promise<Response> {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const token = await tokenFrom(req);
  if (!token) return Response.json({ detail: "that QR code isn't a Kritvia sign-in code" }, { status: 422 });
  const res = await call(req, "claim", { token }, doFetch);
  if (!res) return unreachable();
  const text = await res.text();
  if (!res.ok) return passThrough(res, text);
  const r = JSON.parse(text) as { secret: string; device: string };
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  headers.append("set-cookie", linkCookie(r.secret));
  return new Response(JSON.stringify({ device: r.device }), { status: 200, headers });
}

/** What a scanned code is (an offer to sign this device in, or a login page asking). */
export async function peek(req: Request, doFetch: typeof fetch = fetch): Promise<Response> {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const token = await tokenFrom(req);
  if (!token) return Response.json({ detail: "that QR code isn't a Kritvia sign-in code" }, { status: 422 });
  const res = await call(req, "peek", { token }, doFetch);
  if (!res) return unreachable();
  return passThrough(res, await res.text());
}

/** Poll: 202 while waiting for the yes; 200 once signed in (session cookies set). */
export async function redeem(req: Request, doFetch: typeof fetch = fetch): Promise<Response> {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const token = await tokenFrom(req);
  const secret = parseCookies(req.headers.get("cookie"))[LINK_COOKIE];
  if (!token || !secret) return Response.json({ detail: "this sign-in has expired; scan a new QR code" }, { status: 410 });
  const res = await call(req, "redeem", { token, secret }, doFetch);
  if (!res) return unreachable();
  const text = await res.text();
  if (res.status === 202) return passThrough(res, text);
  if (!res.ok) return passThrough(res, text, res.status === 403 || res.status === 410 ? [linkCookie("")] : []);
  const tokens = JSON.parse(text) as TokenPair;
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const c of sessionCookies(tokens)) headers.append("set-cookie", c);
  headers.append("set-cookie", linkCookie(""));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
