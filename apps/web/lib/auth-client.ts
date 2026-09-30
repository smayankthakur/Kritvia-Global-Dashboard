import { parseErrorBody, type ApiError } from "./api";

/** POST credentials to the BFF (which sets httpOnly cookies). Throws ApiError on failure. */
export async function postAuth(endpoint: "login" | "register", body: Record<string, string>): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/auth/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    throw parseErrorBody(0, null);
  }
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* ignore */
    }
    const ra = res.headers.get("retry-after");
    throw parseErrorBody(res.status, data, ra ? Number(ra) : null) as ApiError;
  }
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Only allow same-site relative redirects after sign-in. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}
