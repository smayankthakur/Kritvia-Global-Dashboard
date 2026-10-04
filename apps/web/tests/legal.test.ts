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

  it("names training providers only as an opt-in, never for Google data or sensitive records", () => {
    expect(PRIVACY_MD).not.toMatch(/Sarvam/);
    expect(PRIVACY_MD).toMatch(/Groq/);
    expect(PRIVACY_MD).toMatch(/Only if a business opts in: Google \(Gemini free tier\), OpenRouter free models, Mistral/);
    expect(PRIVACY_MD).toMatch(/never to an AI model whose provider may train on it/);
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

describe("customer privacy notice", () => {
  it("describes only what the switched-on agents do", async () => {
    const { noticeItems, noticeText } = await import("@/lib/notice");
    expect(noticeItems({ workflows: [] }, "en")).toHaveLength(1);
    const loan = noticeItems({ workflows: ["loan_verification", "kitchen_daily"] }, "en");
    expect(loan).toHaveLength(1);
    expect(loan[0]!.local).toBe(true);
    const d = { business_name: "Mehta Stores", city: "Pune", contact_name: "Ritu", contact_email: "p@m.in", kind: "general", workflows: ["inbox_assistant"], updated_at: "2026-10-04T00:00:00Z" };
    expect(noticeText(d, "en").intro).toContain("Mehta Stores, Pune,");
    expect(noticeText(d, "hi").title).toBe("गोपनीयता सूचना");
    expect(noticeText(d, "hi").rights).toHaveLength(6);
  });
});

describe("customer notice and free models", () => {
  it("says so when the business uses free models that may train", async () => {
    const { noticeText } = await import("@/lib/notice");
    const d = { business_name: "B", city: "", contact_name: "", contact_email: "a@b.in", kind: "general", workflows: [], updated_at: "2026-10-04T00:00:00Z" };
    expect(noticeText(d, "en").how.join(" ")).toContain("do not use your data to train");
    expect(noticeText({ ...d, ai_may_train: true }, "en").how.join(" ")).toContain("may use the content they receive");
  });
});
