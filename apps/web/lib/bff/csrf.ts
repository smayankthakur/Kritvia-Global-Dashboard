/**
 * CSRF tokens (double submit), on top of the Origin check and SameSite cookies.
 *
 * Every page response sets a random token in a cookie that page JavaScript can read
 * (`__Host-kv_csrf` over HTTPS: host-only, Secure, Path=/, so a sibling subdomain can't plant
 * one). The API client copies it into the X-KV-CSRF header on every state-changing request,
 * and the BFF refuses the request unless header and cookie match. A page on another site can
 * make the browser send the cookie but can neither read it nor set the header.
 */
export const CSRF_HEADER = "x-kv-csrf";
export const csrfCookieName = (secure: boolean) => (secure ? "__Host-kv_csrf" : "kv_csrf");
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export function newCsrfToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function csrfCookie(token: string, secure: boolean): string {
  // Not HttpOnly on purpose: the page must read it to echo it in the header.
  return `${csrfCookieName(secure)}=${token}; Path=/; SameSite=Strict${secure ? "; Secure" : ""}; Max-Age=31536000`;
}

function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** True for safe methods, or when the header matches the cookie (either cookie name is accepted). */
export function csrfOk(req: Request): boolean {
  if (SAFE.has(req.method.toUpperCase())) return true;
  const sent = req.headers.get(CSRF_HEADER);
  if (!sent || sent.length < 20) return false;
  const cookies = req.headers.get("cookie");
  const have = readCookie(cookies, "__Host-kv_csrf") ?? readCookie(cookies, "kv_csrf");
  return !!have && equal(sent, have);
}

export function csrfRefused(): Response {
  return Response.json({ detail: "This page is out of date. Reload it and try again." }, { status: 403 });
}

/** Browser side: the header to send with a state-changing request. */
export function csrfHeaders(): Record<string, string> {
  if (typeof document === "undefined") return {};
  const m = document.cookie.match(/(?:^|;\s*)(?:__Host-kv_csrf|kv_csrf)=([^;]+)/);
  return m ? { [CSRF_HEADER]: m[1]! } : {};
}
