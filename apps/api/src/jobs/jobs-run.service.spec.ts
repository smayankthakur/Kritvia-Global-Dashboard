import { JobsRunService } from "./jobs-run.service";

describe("JobsRunService", () => {
  it("run processes only orgs with autopilot enabled", async () => {
    const prisma = {
      org: {
        findMany: jest.fn().mockResolvedValue([{ id: "org-a" }, { id: "org-b" }])
      }
    } as any;
    const policyResolver = {
      getPolicyForOrg: jest
        .fn()
        .mockResolvedValueOnce({ autopilotEnabled: true })
        .mockResolvedValueOnce({ autopilotEnabled: false })
    } as any;
    const activityLog = {
      log: jest.fn()
    } as any;

    const service = new JobsRunService(prisma, policyResolver, activityLog);
    jest
      .spyOn(service, "runForOrg")
      .mockResolvedValue({ invoicesLocked: 2, dealsStaled: 1, nudgesCreated: 3 });

    const result = await service.run(new Date());

    expect(result).toEqual({
      processedOrgs: 1,
      invoicesLocked: 2,
      dealsStaled: 1,
      nudgesCreated: 3
    });
  });

  it("runForOrg is idempotent when nothing qualifies", async () => {
    const prisma = {
      invoice: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
      deal: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
      user: { findFirst: jest.fn().mockResolvedValue({ id: "system-user" }) },
      workItem: { findMany: jest.fn().mockResolvedValue([]) },
      nudge: { findFirst: jest.fn(), create: jest.fn() },
      $transaction: jest
        .fn()
        .mockImplementation(async (ops: Array<Promise<unknown>>) => Promise.all(ops))
    } as any;
    const policyResolver = {
      getPolicyForOrg: jest.fn().mockResolvedValue({
        staleDealAfterDays: 7,
        autopilotNudgeOnOverdue: true
      })
    } as any;
    const activityLog = { log: jest.fn() } as any;

    const service = new JobsRunService(prisma, policyResolver, activityLog);
    const first = await service.runForOrg("org-a", new Date("2026-02-14T00:00:00.000Z"));
    const second = await service.runForOrg("org-a", new Date("2026-02-14T00:00:00.000Z"));

    expect(first).toEqual({ invoicesLocked: 0, dealsStaled: 0, nudgesCreated: 0 });
    expect(second).toEqual({ invoicesLocked: 0, dealsStaled: 0, nudgesCreated: 0 });
    expect(activityLog.log).not.toHaveBeenCalled();
  });
});
