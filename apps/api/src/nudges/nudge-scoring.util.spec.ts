import { NudgeSeverity, NudgeType } from "@prisma/client";
import { computeNudgeScore } from "./nudge-scoring.util";

describe("computeNudgeScore", () => {
  const now = new Date("2026-02-14T00:00:00.000Z");

  it("computes OVERDUE_INVOICE as critical for high days overdue", () => {
    const score = computeNudgeScore({
      type: NudgeType.OVERDUE_INVOICE,
      now,
      dueDate: new Date("2026-01-20T00:00:00.000Z"),
      amount: 12000
    });

    expect(score.severity).toBe(NudgeSeverity.CRITICAL);
    expect(score.priorityScore).toBeGreaterThanOrEqual(70);
    expect(score.meta.daysOverdue).toBeGreaterThanOrEqual(20);
  });

  it("computes OVERDUE_WORK with deal value boost", () => {
    const score = computeNudgeScore({
      type: NudgeType.OVERDUE_WORK,
      now,
      dueDate: new Date("2026-02-01T00:00:00.000Z"),
      dealValue: 250000
    });

    expect(score.severity).toBe(NudgeSeverity.CRITICAL);
    expect(score.priorityScore).toBeGreaterThan(60);
    expect(score.meta.dealValue).toBe(250000);
  });

  it("computes STALE_DEAL severity from idle days", () => {
    const score = computeNudgeScore({
      type: NudgeType.STALE_DEAL,
      now,
      updatedAt: new Date("2026-02-03T00:00:00.000Z")
    });

    expect(score.severity).toBe(NudgeSeverity.HIGH);
    expect(score.priorityScore).toBe(70);
    expect(score.meta.idleDays).toBe(11);
  });
});
