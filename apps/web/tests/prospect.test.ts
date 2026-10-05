import { describe, expect, it } from "vitest";
import { outreachState } from "@/components/leads/prospect-panel";
import type { Schemas } from "@/lib/api";

const base = {
  id: "l1", venture_id: "v1", name: "Ramesh Dhaba", email: null, company: "Ramesh Dhaba", source: "prospector",
  status: "new", score: null, notes: null, created_at: "2026-10-05T05:00:00Z", outreach_step: 0,
} as unknown as Schemas["LeadOut"];

describe("outreachState", () => {
  it("opt-out beats everything", () => {
    expect(outreachState({ ...base, opted_out_at: "x", replied_at: "x", outreach_draft: "hi" }).label).toBe("Opted out");
  });
  it("a reply comes next", () => {
    expect(outreachState({ ...base, replied_at: "x", outreach_draft: "hi" }).label).toBe("Replied");
  });
  it("a drafted WhatsApp is waiting for the owner", () => {
    expect(outreachState({ ...base, outreach_draft: "hi" })).toEqual({ label: "WhatsApp ready to send", tone: "warning" });
  });
  it("a scheduled follow-up, a finished sequence, or nothing yet", () => {
    expect(outreachState({ ...base, next_touch_at: new Date(Date.now() + 86_400_000 * 3).toISOString() }).label).toMatch(/^Next message /);
    expect(outreachState({ ...base, outreach_step: 3 }).label).toBe("Sequence finished");
    expect(outreachState(base).label).toBe("Not contacted");
  });
});

describe("leadName", () => {
  it("shows Google's live name for an unnamed prospect, else the stored name", async () => {
    const { leadName, PLACEHOLDER_NAME } = await import("@/components/leads/prospect-panel");
    const p = { ...base, name: PLACEHOLDER_NAME } as Schemas["LeadOut"];
    expect(leadName({ ...p, place: { name: "Ramesh Dhaba" } } as Schemas["LeadOut"])).toBe("Ramesh Dhaba");
    expect(leadName(p)).toBe("Google Maps listing");
    expect(leadName({ ...p, name: "Ramesh Kumar" } as Schemas["LeadOut"])).toBe("Ramesh Kumar");
  });
});
