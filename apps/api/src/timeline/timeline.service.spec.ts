import { TimelineService } from "./timeline.service";

describe("TimelineService", () => {
  it("computes durations and bottleneck flags for a full lifecycle", () => {
    const service = new TimelineService({} as never);
    const start = new Date("2026-01-01T00:00:00.000Z");

    const milestones = service.buildTimelineMilestones(
      [
        { type: "LEAD_CREATED", timestamp: start },
        { type: "DEAL_CREATED", timestamp: new Date("2026-01-02T00:00:00.000Z") },
        { type: "WORK_ROOT_CREATED", timestamp: new Date("2026-01-03T02:00:00.000Z") },
        { type: "INVOICE_SENT", timestamp: new Date("2026-01-05T04:00:00.000Z") },
        { type: "INVOICE_PAID", timestamp: new Date("2026-01-09T08:00:00.000Z") }
      ],
      48
    );

    expect(milestones).toHaveLength(5);
    expect(milestones[0].durationFromPreviousHours).toBeNull();
    expect(milestones[1].durationFromPreviousHours).toBe(24);
    expect(milestones[2].durationFromPreviousHours).toBe(26);
    expect(milestones[3].durationFromPreviousHours).toBe(50);
    expect(milestones[4].durationFromPreviousHours).toBe(100);

    expect(milestones[1].isBottleneck).toBe(false);
    expect(milestones[2].isBottleneck).toBe(false);
    expect(milestones[3].isBottleneck).toBe(true);
    expect(milestones[4].isBottleneck).toBe(true);
  });
});

