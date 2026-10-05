import { describe, expect, it } from "vitest";
import { PLAN_CARDS, priceFor } from "@/lib/pricing";
import { trialNeedsAttention, trialNote } from "@/lib/trial";

describe("free trial", () => {
  it("is 15 days, needs no card, and is shown as a trial", () => {
    const free = PLAN_CARDS.find((p) => p.code === "free")!;
    expect(free.name).toBe("Free trial");
    expect(free.highlights[0]).toBe("15 days free, then choose a plan");
    expect(priceFor(free, "monthly").note).toBe("No card needed");
  });

  it("says where the trial stands and nudges only near the end", () => {
    expect(trialNote({ ends_at: null, expired: false, held: true, days_left: null })).toMatch(/won't end before online payment opens/);
    expect(trialNote({ ends_at: "x", expired: false, held: false, days_left: 1 })).toBe("Free trial: 1 day left");
    expect(trialNote({ ends_at: "x", expired: true, held: false, days_left: null })).toMatch(/has ended/);
    expect(trialNeedsAttention({ ends_at: "x", expired: false, held: false, days_left: 9 })).toBe(false);
    expect(trialNeedsAttention({ ends_at: "x", expired: false, held: false, days_left: 5 })).toBe(true);
    expect(trialNeedsAttention({ ends_at: null, expired: false, held: true, days_left: null })).toBe(false);
    expect(trialNeedsAttention(null)).toBe(false);
  });
});
