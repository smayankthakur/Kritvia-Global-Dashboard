import { securityLog } from "./security-log";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function firstValue(v: string | null): string | null {
  if (!v) return null;
  return v.split(",")[0]?.trim() || null;
}

/** The host the browser addressed (the tunnel/reverse proxy sets X-Forwarded-Host). */
export function requestHost(req: Request): string {
  return (
    firstValue(req.headers.get("x-forwarded-host")) ??
    firstValue(req.headers.get("host")) ??
    new URL(req.url).host
  );
}

/**
 * CSRF defence for cookie-authenticated writes: every non-GET request must carry an
 * Origin header whose host matches the host that served the app. Browsers always send
 * Origin on cross-site and same-origin POST/PUT/PATCH/DELETE fetches, and a page on
 * another site cannot forge it.
 */
export function isSameOrigin(req: Request, extraTrusted: string[] = trustedOrigins()): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
  const origin = req.headers.get("origin");
  let ok = false;
  if (origin && origin !== "null") {
    try {
      const parsed = new URL(origin);
      // Match the public host (X-Forwarded-Host behind a tunnel/proxy) OR the Host the request
      // actually arrived on: some proxies (GitHub Codespaces) rewrite Origin to the internal
      // address while forwarding the public host. A page on another site still never matches.
      const hosts = new Set([requestHost(req), firstValue(req.headers.get("host"))].filter(Boolean));
      ok = hosts.has(parsed.host) || extraTrusted.includes(parsed.origin);
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    // Header names/values below are not secrets.
    securityLog("origin.refused", req, {
      host: req.headers.get("host"),
      forwarded_host: req.headers.get("x-forwarded-host"),
      trusted: extraTrusted.join(",") || null,
    });
  }
  return ok;
}

export function trustedOrigins(): string[] {
  return (process.env.KRITVIA_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function forbiddenOrigin(): Response {
  return Response.json({ detail: "cross-site request refused" }, { status: 403 });
}
