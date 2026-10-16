/** A coupon from a sign-up link (/register?coupon=FIRST50), applied to the organisation made at onboarding. */
const KEY = "kv-coupon";

export function couponFromSearch(search: string): string | null {
  const c = new URLSearchParams(search).get("coupon")?.toUpperCase().replace(/[^A-Z0-9]/g, "") ?? "";
  return c.length >= 4 && c.length <= 20 ? c : null;
}

export function rememberCoupon(search: string): string | null {
  const c = couponFromSearch(search);
  if (!c) return null;
  try {
    window.localStorage.setItem(KEY, c);
  } catch {
    /* private mode: the owner can still enter it under Plan & billing */
  }
  return c;
}

export function takeCoupon(): string | null {
  try {
    const c = window.localStorage.getItem(KEY);
    window.localStorage.removeItem(KEY);
    return c;
  } catch {
    return null;
  }
}
