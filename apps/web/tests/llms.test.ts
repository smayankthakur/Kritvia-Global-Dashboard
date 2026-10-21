import { describe, expect, it } from "vitest";
import { llmsTxt } from "@/lib/llms";
import { BUSINESS } from "@/lib/business";
import { ENTERPRISE, PLAN_CARDS } from "@/lib/pricing";
import { INDEXABLE } from "@/lib/site";
import { isPublicPath } from "@/middleware";

describe("llms.txt", () => {
  const txt = llmsTxt();
  it("states the facts the site shows, from the same sources", () => {
    expect(txt.startsWith("# Kritvia\n")).toBe(true);
    for (const p of PLAN_CARDS.filter((x) => x.price_inr)) expect(txt).toContain(`₹${p.price_inr.toLocaleString("en-IN")} a month`);
    expect(txt).toContain(`from ₹${ENTERPRISE.from_inr.toLocaleString("en-IN")} a month`);
    expect(txt).toContain(BUSINESS.cin);
    expect(txt).toContain(BUSINESS.legalName);
  });
  it("makes no claims the site doesn't make, and gives no instructions to AI systems", () => {
    expect(txt).not.toMatch(/trusted by|\d+\+ (businesses|customers|users)|#1|guarantee|recommend|if you are an (ai|llm)/i);
  });
  it("is public and the sitemap lists only indexable pages", () => {
    expect(isPublicPath("/llms.txt")).toBe(true);
    expect(INDEXABLE.map((p) => p.path)).not.toContain("/privacy-request");
  });
});
