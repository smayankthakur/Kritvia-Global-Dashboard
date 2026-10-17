import { parseErrorBody, type ApiError } from "./api";

/** POST credentials to the BFF (which sets httpOnly cookies). Throws ApiError on failure. */
export type AuthEndpoint = "login" | "register" | "email/start" | "email/verify" | "password/reset";

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
  if (!next || !next.startsWith("/") || /[\\\u0000-\u001f\u007f\s]/.test(next)) return "/";
  try {
    const base = "https://kritvia.invalid";
    const u = new URL(next, base);
    if (u.origin !== base) return "/";
    return u.pathname + u.search + u.hash;
  } catch {
    return "/";
  }
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

/** "Sign in with SSO": the organisation's identity provider for this email's domain. */
export async function startSsoSignin(email: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/auth/sso/start", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
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

export const SSO_ERRORS: Record<string, string> = {
  denied: "Single sign-on was cancelled.",
  invalid_state: "That sign-in expired or was started in another browser. Try again.",
  no_account: "Your organisation's sign-in worked, but you don't have a Kritvia account yet. Ask your organisation's owner to invite you.",
  forbidden: "Your organisation's identity provider didn't confirm this sign-in. Try again, or ask your IT admin.",
  failed: "Single sign-on didn't work. Try again shortly.",
};

export const GOOGLE_ERRORS: Record<string, string> = {
  denied: "Google sign-in was cancelled.",
  invalid_state: "That Google sign-in expired or was started in another browser. Try again.",
  forbidden: "This account is disabled, or the email is linked to a different Google account.",
  failed: "Google sign-in didn't work. Try again, or use an email code.",
};
