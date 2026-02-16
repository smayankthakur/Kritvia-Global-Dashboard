import {
  averageCloseDays,
  averagePaymentDelayDays,
  bucketizeDealAge,
  computePipelineWeightedForecast,
  safePct,
  stageProbability
} from "./revenue-velocity.util";

describe("Revenue Velocity Utils", () => {
  it("safePct handles division safely and rounds to one decimal", () => {
    expect(safePct(0, 0)).toBe(0);
    expect(safePct(1, 3)).toBe(33.3);
    expect(safePct(2, 4)).toBe(50);
  });

  it("bucketizeDealAge maps deal age to expected pipeline buckets", () => {
    const now = new Date("2026-02-16T00:00:00.000Z");

    expect(bucketizeDealAge(new Date("2026-02-16T00:00:00.000Z"), now)).toBe("0_7");
    expect(bucketizeDealAge(new Date("2026-02-09T00:00:00.000Z"), now)).toBe("0_7");
    expect(bucketizeDealAge(new Date("2026-02-08T00:00:00.000Z"), now)).toBe("8_14");
    expect(bucketizeDealAge(new Date("2026-02-01T00:00:00.000Z"), now)).toBe("15_30");
    expect(bucketizeDealAge(new Date("2026-01-10T00:00:00.000Z"), now)).toBe("30_plus");
  });

  it("averageCloseDays computes average lifecycle duration in days", () => {
    const avg = averageCloseDays([
      {
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        wonAt: new Date("2026-01-06T00:00:00.000Z")
      },
      {
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        wonAt: new Date("2026-01-10T00:00:00.000Z")
      }
    ]);

    expect(avg).toBe(6.5);
    expect(averageCloseDays([])).toBe(0);
    expect(
      averageCloseDays([
        {
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          wonAt: null
        }
      ])
    ).toBe(0);
  });

  it("averagePaymentDelayDays computes average days from sent to paid", () => {
    const avg = averagePaymentDelayDays([
      {
        sentAt: new Date("2026-01-01T00:00:00.000Z"),
        paidAt: new Date("2026-01-03T00:00:00.000Z")
      },
      {
        sentAt: new Date("2026-01-10T00:00:00.000Z"),
        paidAt: new Date("2026-01-16T00:00:00.000Z")
      }
    ]);
    expect(avg).toBe(4);
    expect(averagePaymentDelayDays([])).toBe(0);
  });

  it("stageProbability maps stage text deterministically", () => {
    expect(stageProbability("proposal")).toBe(0.7);
    expect(stageProbability("qualified")).toBe(0.4);
    expect(stageProbability("open")).toBe(0.4);
    expect(stageProbability("new")).toBe(0.2);
  });

  it("computePipelineWeightedForecast uses expectedCloseDate and fallback weights", () => {
    const now = new Date("2026-02-16T00:00:00.000Z");
    const result = computePipelineWeightedForecast(
      [
        {
          valueAmount: 100000,
          stage: "proposal",
          expectedCloseDate: new Date("2026-02-20T00:00:00.000Z")
        },
        {
          valueAmount: 50000,
          stage: "qualified",
          expectedCloseDate: new Date("2026-03-25T00:00:00.000Z")
        },
        {
          valueAmount: 20000,
          stage: "open",
          expectedCloseDate: null
        }
      ],
      now
    );

    expect(result).toEqual({
      pipelineWeighted30: 72400,
      pipelineWeighted60: 94800
    });
  });
});
