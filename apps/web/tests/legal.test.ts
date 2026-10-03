import { describe, expect, it } from "vitest";
import { PRIVACY_MD } from "@/lib/legal/privacy";
import { TERMS_MD } from "@/lib/legal/terms";
import { needsTerms } from "@/lib/terms";

describe("terms acceptance", () => {
  it("asks only when the accepted version differs from the one in force", () => {
    expect(needsTerms(undefined)).toBe(false);
    expect(needsTerms({ terms_version: null, terms_current: "2026-10-03" })).toBe(true);
    expect(needsTerms({ terms_version: "2026-01-01", terms_current: "2026-10-03" })).toBe(true);
    expect(needsTerms({ terms_version: "2026-10-03", terms_current: "2026-10-03" })).toBe(false);
  });
});

describe("legal text", () => {
  it("carries Google's Limited Use disclosure and no unfilled placeholders", () => {
    expect(PRIVACY_MD).toContain("including the Limited Use requirements");
    expect(TERMS_MD).toContain("Limited Use requirements");
    for (const md of [PRIVACY_MD, TERMS_MD]) expect(md).not.toMatch(/\[(CIN|registered address)\]/);
  });

  it("names only providers that do not train on customer data", () => {
    expect(PRIVACY_MD).not.toMatch(/OpenRouter|Sarvam/);
    expect(PRIVACY_MD).toMatch(/Groq/);
  });
});

describe("status incidents", () => {
  it("describes how long an incident lasted", async () => {
    const { incidentLength } = await import("@/lib/status");
    const base = { summary: "x", started_at: "2026-10-03T10:00:00Z" };
    expect(incidentLength({ ...base, resolved_at: "2026-10-03T10:15:00Z" })).toBe("about 15 minutes");
    expect(incidentLength({ ...base, resolved_at: "2026-10-03T10:01:00Z" })).toBe("about 5 minutes");
    expect(incidentLength({ ...base, resolved_at: "2026-10-03T12:10:00Z" })).toBe("2 h 10 min");
    expect(incidentLength({ ...base, resolved_at: null }, new Date("2026-10-03T11:00:00Z"))).toBe("1 h");
  });
});
