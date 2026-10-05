/**
 * Structured security log lines from the web app's server (BFF): refused cross-site requests and
 * missing CSRF tokens. One JSON line per event on stderr, collected with the container logs
 * (`docker compose logs web | grep kritvia.security`). No cookies, tokens or bodies are logged.
 */
export function securityLog(event: string, req: Request, details: Record<string, string | number | null> = {}): void {
  const line = {
    logger: "kritvia.security",
    event,
    severity: "warning",
    at: new Date().toISOString(),
    method: req.method,
    path: new URL(req.url).pathname.slice(0, 120),
    ip: req.headers.get("cf-connecting-ip") ?? null,
    origin: req.headers.get("origin")?.slice(0, 120) ?? null,
    ...details,
  };
  console.warn(JSON.stringify(line));
}
