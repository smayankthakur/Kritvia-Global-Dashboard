import { explainHealthScoreDelta } from "./health-score-explain.util";
import { HealthScoreBreakdown } from "./dto/health-score-response.dto";

function mockBreakdown(input: Partial<HealthScoreBreakdown>): HealthScoreBreakdown {
  return {
    overdueWorkPct: 0,
    overdueInvoicePct: 0,
    staleDealsPct: 0,
    hygieneCount: 0,
    penalties: {
      overdueWorkPenalty: 0,
      overdueInvoicePenalty: 0,
      staleDealsPenalty: 0,
      hygienePenalty: 0
    },
    thresholds: {
      staleDays: 7
    },
    ...input
  };
}

describe("explainHealthScoreDelta", () => {
  it("returns only worsening drivers sorted by impact desc", () => {
    const previous = mockBreakdown({
      overdueWorkPct: 0.1,
      overdueInvoicePct: 0.2,
      staleDealsPct: 0.1,
      hygieneCount: 5,
      penalties: {
        overdueWorkPenalty: 4,
        overdueInvoicePenalty: 6,
        staleDealsPenalty: 2,
        hygienePenalty: 1
      }
    });
    const target = mockBreakdown({
      overdueWorkPct: 0.25,
      overdueInvoicePct: 0.2,
      staleDealsPct: 0.3,
      hygieneCount: 12,
      penalties: {
        overdueWorkPenalty: 10,
        overdueInvoicePenalty: 6,
        staleDealsPenalty: 6,
        hygienePenalty: 2
      }
    });

    const drivers = explainHealthScoreDelta(previous, target);
    expect(drivers).toHaveLength(3);
    expect(drivers[0].key).toBe("OVERDUE_WORK");
    expect(drivers[0].impactPoints).toBe(6);
    expect(drivers[1].key).toBe("STALE_DEALS");
    expect(drivers[1].impactPoints).toBe(4);
    expect(drivers[2].key).toBe("HYGIENE");
    expect(drivers[2].impactPoints).toBe(1);
    expect(drivers.some((item) => item.key === "INVOICE_AGING")).toBe(false);
  });
});
