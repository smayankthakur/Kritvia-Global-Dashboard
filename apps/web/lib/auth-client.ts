import { parseErrorBody, type ApiError } from "./api";

/** POST credentials to the BFF (which sets httpOnly cookies). Throws ApiError on failure. */
export type AuthEndpoint = "login" | "register" | "email/start" | "email/verify";

export async function postAuth(endpoint: AuthEndpoint, body: Record<string, string>): Promise<void> {
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

/** Starts "Sign in with Google": the BFF pins a nonce cookie, then we leave for Google. */
export async function startGoogleSignin(): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/auth/google/start", { method: "POST", credentials: "same-origin" });
  } catch {
    throw parseErrorBody(0, null);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) throw parseErrorBody(res.status, data) as ApiError;
  window.location.assign((data as { url: string }).url);
}

export const GOOGLE_ERRORS: Record<string, string> = {
  denied: "Google sign-in was cancelled.",
  invalid_state: "That Google sign-in expired or was started in another browser. Try again.",
  forbidden: "This account is disabled, or the email is linked to a different Google account.",
  failed: "Google sign-in didn't work. Try again, or use an email code.",
};
