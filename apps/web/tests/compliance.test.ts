import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { allowed, consentVersion, gpcEnabled, needsBanner, OPTIONAL_TOOLS, readConsent, writeConsent, type OptionalTool } from "@/lib/consent";
import { COOKIES_MD } from "@/lib/legal/cookies";
import { PRIVACY_MD } from "@/lib/legal/privacy";
import { REFUNDS_MD } from "@/lib/legal/refunds";
import { TERMS_MD } from "@/lib/legal/terms";
// @ts-expect-error plain ESM script without types
import { scanCopy, scanPrices, scanThirdParty } from "../scripts/trust-scan.mjs";

const web = join(__dirname, "..");
const read = (p: string) => readFileSync(join(web, p), "utf8");
const ANALYTICS: OptionalTool = { id: "plausible", category: "analytics", name: "Plausible", purpose: "count visits", provider: "Plausible Insights", cookies: [] };

describe("cookie consent", () => {
  afterEach(() => localStorage.clear());

  it("shows no banner while every cookie is strictly necessary", () => {
    expect(OPTIONAL_TOOLS).toHaveLength(0);
    expect(needsBanner(OPTIONAL_TOOLS, null)).toBe(false);
  });

  it("loads nothing optional before a choice, and asks again when the tools change", () => {
    expect(needsBanner([ANALYTICS], null)).toBe(true);
    expect(allowed("analytics", null, false)).toBe(false);
    const rec = writeConsent(["analytics"], [ANALYTICS]);
    expect(allowed("analytics", rec, false)).toBe(true);
    expect(readConsent([ANALYTICS])).not.toBeNull();
    expect(readConsent([ANALYTICS, { ...ANALYTICS, id: "chat", category: "functional" }])).toBeNull();
    expect(consentVersion([ANALYTICS])).toBe("plausible:analytics");
  });

  it("treats Global Privacy Control as a refusal and expires choices after a year", () => {
    expect(gpcEnabled({ globalPrivacyControl: true })).toBe(true);
    expect(gpcEnabled({})).toBe(false);
    const rec = writeConsent(["analytics"], [ANALYTICS], true);
    expect(rec.granted).toEqual([]);
    expect(allowed("analytics", { ...rec, granted: ["analytics"] }, true)).toBe(false);
    writeConsent(["analytics"], [ANALYTICS]);
    expect(readConsent([ANALYTICS], Date.now() + 366 * 86400_000)).toBeNull();
  });

  it("lists every cookie the app sets in the Cookie Policy", () => {
    const names = new Set<string>();
    for (const f of ["lib/bff/cookies.ts", "lib/bff/csrf.ts", "app/api/oauth/google/start/route.ts"]) {
      try {
        for (const m of read(f).matchAll(/"(kv_[a-z_]+)"/g)) names.add(m[1]!);
      } catch {
        // file moved: the names below still have to be listed
      }
    }
    for (const n of ["kv_at", "kv_rt", "kv_theme", "kv_org", ...names]) expect(COOKIES_MD, n).toContain(n);
    for (const t of OPTIONAL_TOOLS) for (const c of t.cookies) expect(COOKIES_MD, c).toContain(c);
  });
});

describe("policies", () => {
  it("cover GDPR, CCPA, children and the request form", () => {
    expect(PRIVACY_MD).toMatch(/European Economic Area/);
    expect(PRIVACY_MD).toMatch(/California/);
    expect(PRIVACY_MD).toMatch(/do not sell personal information/);
    expect(PRIVACY_MD).toMatch(/18 or over/);
    expect(PRIVACY_MD).toContain("(/privacy-request)");
    expect(PRIVACY_MD).toContain("(/cookies)");
    expect(TERMS_MD).toContain("(/refunds)");
    expect(TERMS_MD).toMatch(/"Coming soon"/);
    expect(REFUNDS_MD).toMatch(/cancel a monthly or yearly plan at any time/);
  });

  it("asks for the 18+ confirmation before sign-up and before re-accepting terms", () => {
    expect(read("app/(auth)/register/page.tsx")).toMatch(/I am 18 or older/);
    expect(read("components/legal/terms-gate.tsx")).toMatch(/adult: true/);
  });
});

describe("trust scan", () => {
  it("finds no dark patterns, unsupported claims or hidden fees in the copy", () => {
    expect(scanCopy()).toEqual([]);
    expect(scanPrices()).toEqual([]);
  });

  it("finds no third-party scripts, frames or pixels, and the CSP allows none", () => {
    expect(scanThirdParty()).toEqual([]);
  });

  it("catches the patterns it is meant to", async () => {
    // @ts-expect-error plain ESM script without types
    const { RULES } = await import("../scripts/trust-scan.mjs");
    const hit = (id: string, text: string) => (RULES as { id: string; re: RegExp }[]).find((r) => r.id === id)!.re.test(text);
    expect(hit("false-urgency", "Only 3 spots left!")).toBe(true);
    expect(hit("social-proof", "Trusted by 10,000+ businesses")).toBe(true);
    expect(hit("social-proof", "3 businesses, 15 people")).toBe(false);
    expect(hit("unsupported-claim", "100% secure, bank-grade encryption")).toBe(true);
    expect(hit("confirmshaming", "No thanks, I don't want to grow my business")).toBe(true);
    expect(hit("pre-ticked", "<input type=checkbox defaultChecked />")).toBe(true);
    expect(hit("hidden-fee", "plus a small convenience fee")).toBe(true);
    expect(hit("forced-continuity", "Start a free trial, then we'll charge your card ₹2,499")).toBe(true);
    expect(hit("forced-continuity", "Start 15-day free trial")).toBe(false);
  });
});
