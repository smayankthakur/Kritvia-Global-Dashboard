/** A partner's referral code, carried from /register?ref=CODE to the organisation made at onboarding. */
const KEY = "kv-ref";

export function rememberReferral(search: string): void {
  const code = new URLSearchParams(search).get("ref")?.toUpperCase().replace(/[^A-Z0-9]/g, "") ?? "";
  if (code.length < 4 || code.length > 12) return;
  try {
    window.localStorage.setItem(KEY, code);
  } catch {
    /* private mode: the owner can still enter the code under Plan & billing */
  }
}

export function takeReferral(): string | null {
  try {
    const code = window.localStorage.getItem(KEY);
    window.localStorage.removeItem(KEY);
    return code;
  } catch {
    return null;
  }
}
