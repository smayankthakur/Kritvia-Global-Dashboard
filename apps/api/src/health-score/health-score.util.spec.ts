import { computeHealthScore } from "./health-score.util";

describe("computeHealthScore", () => {
  it("calculates expected penalties and total score", () => {
    const result = computeHealthScore({
      overdueWorkPct: 0.5,
      overdueInvoicePct: 0.2,
      staleDealsPct: 0.25,
      hygieneCount: 10,
      staleDays: 7
    });

    expect(result.breakdown.penalties.overdueWorkPenalty).toBe(20);
    expect(result.breakdown.penalties.overdueInvoicePenalty).toBe(6);
    expect(result.breakdown.penalties.staleDealsPenalty).toBe(5);
    expect(result.breakdown.penalties.hygienePenalty).toBe(2);
    expect(result.score).toBe(67);
  });

  it("caps penalties at configured limits and floors score at zero", () => {
    const result = computeHealthScore({
      overdueWorkPct: 5,
      overdueInvoicePct: 5,
      staleDealsPct: 5,
      hygieneCount: 500,
      staleDays: 7
    });

    expect(result.breakdown.penalties.overdueWorkPenalty).toBe(40);
    expect(result.breakdown.penalties.overdueInvoicePenalty).toBe(30);
    expect(result.breakdown.penalties.staleDealsPenalty).toBe(20);
    expect(result.breakdown.penalties.hygienePenalty).toBe(10);
    expect(result.score).toBe(0);
  });
});
