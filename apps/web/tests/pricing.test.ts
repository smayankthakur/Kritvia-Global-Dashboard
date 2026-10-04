import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentAllowed, ENTERPRISE, PLAN_CARDS, priceFor, TOKEN_PACKS, tokensLabel } from "@/lib/pricing";

// The API's plans.py is the source of truth; the public price list must match it.
const PLANS_PY = readFileSync(join(__dirname, "../../api/kritvia_api/plans.py"), "utf8");

describe("pricing 2026–27", () => {
  it("lists Free, Starter, Growth (recommended) and Scale, with Enterprise from ₹29,999", () => {
    expect(PLAN_CARDS.map((p) => [p.code, p.price_inr, p.price_annual_inr])).toEqual([
      ["free", 0, null],
      ["starter", 2499, 24_990],
      ["growth", 6999, 69_990],
      ["scale", 14_999, 149_990],
    ]);
    expect(PLAN_CARDS.filter((p) => p.featured).map((p) => p.code)).toEqual(["growth"]);
    expect(ENTERPRISE.from_inr).toBe(29_999);
    expect(TOKEN_PACKS.map((t) => t.price_inr)).toEqual([1499, 4999, 9999]);
  });

  it("matches the API's plans.py", () => {
    for (const p of PLAN_CARDS) {
      const line = PLANS_PY.split("\n").find((l) => l.includes(`"${p.code}", "${p.name}",`));
      expect(line, p.code).toBeTruthy();
      const nums = line!.replace(/_/g, "").match(/\d+/g)!.map(Number);
      expect(nums[0], p.code).toBe(p.price_inr);
      if (p.price_annual_inr) expect(nums[1], p.code).toBe(p.price_annual_inr);
      expect(PLANS_PY.replace(/_/g, "")).toContain(String(p.monthly_tokens));
      for (const h of p.highlights) expect(PLANS_PY, `${p.code}: ${h}`).toContain(h);
    }
  });

  it("shows yearly prices as a monthly equivalent", () => {
    expect(priceFor({ price_inr: 2499, price_annual_inr: 24_990 }, "annual")).toEqual({ big: "₹2,082", note: "Billed ₹24,990 a year" });
    expect(priceFor({ price_inr: 2499, price_annual_inr: 24_990 }, "monthly").big).toBe("₹2,499");
    expect(priceFor({ price_inr: 0, price_annual_inr: null }, "annual").note).toBe("Free forever");
    expect(tokensLabel(15_000_000)).toBe("15M");
    expect(tokensLabel(300_000)).toBe("300K");
  });

  it("gates agents like the API", () => {
    expect(agentAllowed("core", "kitchen_daily", "kitchen")).toBe(false);
    expect(agentAllowed("kind", "kitchen_daily", "kitchen")).toBe(true);
    expect(agentAllowed("kind", "loan_verification", "kitchen")).toBe(false);
    expect(agentAllowed("core", "lead_triage", "software")).toBe(true);
    expect(agentAllowed("all", "loan_verification", "general")).toBe(true);
  });
});
