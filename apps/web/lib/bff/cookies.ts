/** Session cookies set by the BFF. Both are httpOnly: page JavaScript never sees a token. */
export const ACCESS_COOKIE = "kv_at";
export const REFRESH_COOKIE = "kv_rt";
export const REFRESH_MAX_AGE = 30 * 24 * 60 * 60;

/** Non-sensitive preference cookies (readable by the page). */
export const THEME_COOKIE = "kv_theme";
export const ORG_COOKIE = "kv_org";

export interface CookieOptions {
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  path?: string;
}

export function cookieSecure(): boolean {
  if (process.env.KRITVIA_COOKIE_SECURE === "false") return false;
  if (process.env.KRITVIA_COOKIE_SECURE === "true") return true;
  return process.env.NODE_ENV === "production";
}

export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? "/"}`);
  if (opts.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`);
    if (opts.maxAge <= 0) parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  }
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  parts.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  return parts.join("; ");
}

export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k || k in out) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export interface TokenPair {
  access_token: string;
  expires_in?: number;
  refresh_token?: string | null;
}

/** Set-Cookie values for a fresh token pair. */
export function sessionCookies(tokens: TokenPair, secure = cookieSecure()): string[] {
  const out = [
    serializeCookie(ACCESS_COOKIE, tokens.access_token, {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      maxAge: tokens.expires_in ?? 3600,
    }),
  ];
  if (tokens.refresh_token) {
    out.push(
      serializeCookie(REFRESH_COOKIE, tokens.refresh_token, {
        httpOnly: true,
        secure,
        sameSite: "Lax",
        maxAge: REFRESH_MAX_AGE,
      }),
    );
  }
  return out;
}

export function clearSessionCookies(secure = cookieSecure()): string[] {
  return [ACCESS_COOKIE, REFRESH_COOKIE].map((n) =>
    serializeCookie(n, "", { httpOnly: true, secure, sameSite: "Lax", maxAge: 0 }),
  );
}
