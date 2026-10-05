/**
 * Cookie and tracker consent.
 *
 * Kritvia today sets only strictly necessary cookies (see lib/legal/cookies.ts), which need no
 * consent, so OPTIONAL_TOOLS is empty and no banner is shown. To add anything that is not
 * strictly necessary (analytics, a chat widget, a video embed that sets cookies):
 *
 *   1. add it to OPTIONAL_TOOLS with an honest description and its cookies;
 *   2. load it only inside <ConsentGate category="..."> (components/legal/consent.tsx), never
 *      from a plain <script> tag; the gate renders nothing until the visitor opts in;
 *   3. list its cookies in the Cookie Policy (tests/consent.test.ts checks this).
 *
 * Rules the banner follows (GDPR/ePrivacy, DPDP s.6, CCPA/GPC, and the dark-pattern guidance
 * of India's CCPA 2023 and the EDPB): nothing optional runs before a choice; "Reject all" is as
 * easy and as prominent as "Accept all"; no pre-ticked boxes; the choice can be changed at any
 * time from the footer; a Global Privacy Control signal counts as "reject"; choices expire after
 * 12 months and when the list of tools changes.
 */
export type Category = "analytics" | "functional" | "marketing";

export interface OptionalTool {
  id: string;
  category: Category;
  name: string;
  purpose: string;
  provider: string;
  cookies: string[];
}

export const OPTIONAL_TOOLS: OptionalTool[] = [];

export const CATEGORY_TEXT: Record<Category, { title: string; body: string }> = {
  functional: { title: "Extra features", body: "Embedded content and helpers that remember things across visits." },
  analytics: { title: "Usage measurement", body: "Counts visits and clicks so we can improve Kritvia. Never sold or used for ads." },
  marketing: { title: "Marketing", body: "Measures whether our adverts work." },
};

export const CONSENT_KEY = "kv_consent";
const MAX_AGE_MS = 365 * 86400_000;

export interface ConsentRecord {
  v: string; // version: the set of tools the choice was made for
  at: number;
  granted: Category[];
  gpc?: boolean;
}

/** The version changes whenever optional tools are added or removed, so people are asked again. */
export function consentVersion(tools: OptionalTool[] = OPTIONAL_TOOLS): string {
  return tools
    .map((t) => `${t.id}:${t.category}`)
    .sort()
    .join(",");
}

export function categoriesInUse(tools: OptionalTool[] = OPTIONAL_TOOLS): Category[] {
  return [...new Set(tools.map((t) => t.category))];
}

/** Global Privacy Control (navigator.globalPrivacyControl): treated as "reject all". */
export function gpcEnabled(nav: unknown = typeof navigator === "undefined" ? undefined : navigator): boolean {
  return Boolean((nav as { globalPrivacyControl?: boolean } | undefined)?.globalPrivacyControl);
}

export function readConsent(tools: OptionalTool[] = OPTIONAL_TOOLS, now = Date.now()): ConsentRecord | null {
  try {
    const raw = localStorage.getItem(CONSENT_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as ConsentRecord;
    if (rec.v !== consentVersion(tools) || now - rec.at > MAX_AGE_MS) return null;
    return rec;
  } catch {
    return null;
  }
}

export function writeConsent(granted: Category[], tools: OptionalTool[] = OPTIONAL_TOOLS, gpc = false): ConsentRecord {
  const rec: ConsentRecord = { v: consentVersion(tools), at: Date.now(), granted: gpc ? [] : granted, gpc };
  try {
    localStorage.setItem(CONSENT_KEY, JSON.stringify(rec));
  } catch {
    // storage blocked: nothing optional loads, and we ask again next time
  }
  window.dispatchEvent(new Event("kv-consent"));
  return rec;
}

/** Whether a category may load now. Nothing optional is ever allowed without a stored choice. */
export function allowed(category: Category, rec: ConsentRecord | null, gpc: boolean): boolean {
  if (gpc && (category === "analytics" || category === "marketing")) return false;
  return !!rec && rec.granted.includes(category);
}

/** The banner shows only when there is a real choice to make and none has been made. */
export function needsBanner(tools: OptionalTool[], rec: ConsentRecord | null): boolean {
  return tools.length > 0 && rec === null;
}
