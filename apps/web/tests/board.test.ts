import { describe, expect, it } from "vitest";
import { budgetFraction, budgetTone, formatSpend, formatTokens, groupTickets, humanNote, parseTokens } from "@/lib/board";

const t = (status: string, finished?: string) =>
  ({ id: status + (finished ?? ""), run_id: null, workflow: null, role: "ops", title: "x", status, note: "", delegated_from: null,
     cost_usd: 0, pending_approval_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-03T00:00:00Z",
     finished_at: finished ?? null }) as never;

describe("board helpers", () => {
  it("parses budgets typed by hand", () => {
    expect(parseTokens("500k")).toBe(500_000);
    expect(parseTokens("1.5M")).toBe(1_500_000);
    expect(parseTokens("20,000")).toBe(20_000);
    expect(parseTokens("lots")).toBeNull();
  });
  it("formats tokens and spend for an owner", () => {
    expect(formatTokens(980)).toBe("980");
    expect(formatTokens(340_000)).toBe("340k");
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatSpend(0)).toBe("₹0");
    expect(formatSpend(0.005)).toBe("under ₹1");
    expect(formatSpend(2.5)).toBe("₹210");
  });
  it("budget fraction and tone: 0 pauses, 80% warns, no cap is neutral", () => {
    expect(budgetFraction({ monthly_tokens: null, used_tokens: 5 })).toBeNull();
    expect(budgetFraction({ monthly_tokens: 0, used_tokens: 0 })).toBe(1);
    expect(budgetTone(budgetFraction({ monthly_tokens: 100, used_tokens: 85 }))).toBe("warning");
    expect(budgetTone(budgetFraction({ monthly_tokens: 100, used_tokens: 120 }))).toBe("danger");
    expect(budgetTone(null)).toBe("neutral");
  });
  it("turns runner errors into something an owner can act on", () => {
    expect(humanNote("all deployments failed for tier 'extract': groq: ConnectError")).toMatch(/could not be reached/);
    expect(humanNote("Paused: this agent's monthly budget is used up")).toMatch(/budget/);
    expect(humanNote("RuntimeError: step limit (60) exceeded — possible loop")).toMatch(/circles/);
    expect(humanNote("ValueError: workflow is disabled")).toBe("workflow is disabled");
  });
  it("groups tickets into columns, drops cancelled and old done cards", () => {
    const now = new Date("2026-10-10T00:00:00Z");
    const g = groupTickets([t("open"), t("waiting_approval"), t("blocked"), t("cancelled"),
                            t("done", "2026-10-09T00:00:00Z"), t("done", "2026-09-01T00:00:00Z")], now);
    expect(g.open).toHaveLength(1);
    expect(g.waiting_approval).toHaveLength(1);
    expect(g.blocked).toHaveLength(1);
    expect(g.done).toHaveLength(1);
  });
});
