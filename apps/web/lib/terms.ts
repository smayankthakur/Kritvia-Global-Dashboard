/**
 * Terms acceptance (ToS 1.3) and the 18+ confirmation (ToS 4.5). The sign-up page records both
 * ticks (only together) in this tab's session storage;
 * once the account exists, the app gate turns it into a stored acceptance on the server.
 * People who signed up before, or when the terms change, accept in a dialog instead.
 */
const KEY = "kv_terms_intent";

export function markTermsIntent(ticked: boolean): void {
  try {
    if (ticked) sessionStorage.setItem(KEY, "1");
    else sessionStorage.removeItem(KEY);
  } catch {
    // storage unavailable: the gate's dialog asks instead
  }
}

/** True once, if the person ticked the box on the sign-up page in this tab. */
export function consumeTermsIntent(): boolean {
  try {
    const v = sessionStorage.getItem(KEY) === "1";
    sessionStorage.removeItem(KEY);
    return v;
  } catch {
    return false;
  }
}

export function needsTerms(me: { terms_version?: string | null; terms_current: string } | undefined): boolean {
  return !!me && me.terms_version !== me.terms_current;
}
