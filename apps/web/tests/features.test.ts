import { describe, expect, it } from "vitest";
import { FEATURES, UNDERNEATH } from "@/lib/features";
import { llmsTxt } from "@/lib/llms";
import { PLAN_CARDS } from "@/lib/pricing";
import { INDEXABLE } from "@/lib/site";
import { isPublicPath } from "@/middleware";

describe("What Kritvia does (/features)", () => {
  it("is public, indexed and listed in llms.txt", () => {
    expect(isPublicPath("/features")).toBe(true);
    expect(INDEXABLE.map((p) => p.path)).toContain("/features");
    const txt = llmsTxt();
    expect(txt).toContain("/features");
    for (const f of FEATURES) expect(txt).toContain(f.answer);
    for (const u of UNDERNEATH) expect(txt).toContain(u);
  });
  it("has unique anchors and a plan line on every job", () => {
    expect(new Set(FEATURES.map((f) => f.id)).size).toBe(FEATURES.length);
    for (const f of FEATURES) {
      expect(f.id).toMatch(/^[a-z-]+$/);
      expect(f.plans.length).toBeGreaterThan(5);
      expect(f.points.length).toBeGreaterThan(0);
    }
  });
  it("names only plans that exist", () => {
    const names = new Set([...PLAN_CARDS.map((p) => p.name), "Enterprise"]);
    for (const f of FEATURES)
      for (const m of f.plans.matchAll(/\b(Free trial|Starter|Growth|Scale|Enterprise|Pro|Business|Basic)\b/g)) expect(names).toContain(m[1]);
  });
  it("makes no claims the product can't back", () => {
    const all = JSON.stringify({ FEATURES, UNDERNEATH });
    expect(all).not.toMatch(/trusted by|\d+\+ (businesses|customers|users)|#1|guarantee|best-in-class|world's|thousands of|coming soon/i);
  });
});
