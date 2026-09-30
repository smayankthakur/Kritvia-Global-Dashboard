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
  if (!origin || origin === "null") return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.host === requestHost(req)) return true;
  return extraTrusted.includes(parsed.origin);
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
