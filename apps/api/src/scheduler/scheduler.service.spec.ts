import { SchedulerService } from "./scheduler.service";
import * as queues from "../jobs/queues";

describe("SchedulerService", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
    process.env.SCHEDULER_ENABLED = "true";
    process.env.SCHEDULER_MODE = "worker";
    process.env.SCHED_TZ = "UTC";
    process.env.FEATURE_AI_ENABLED = "true";
    process.env.LLM_ENABLED = "true";
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  function createService() {
    const jobService = {
      enqueue: jest.fn(),
      runNow: jest.fn()
    } as never;
    const prisma = {
      org: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findFirst: jest.fn().mockResolvedValue(null) }
    } as never;
    const healthScore = {} as never;
    return new SchedulerService(jobService, prisma, healthScore);
  }

  it("registers repeatables when enabled", async () => {
    const aiAdd = jest.fn().mockResolvedValue({});
    const maintAdd = jest.fn().mockResolvedValue({});
    jest.spyOn(queues, "getQueue").mockImplementation(((name: queues.QueueName) => {
      if (name === "ai") {
        return {
          add: aiAdd,
          getRepeatableJobs: jest.fn().mockResolvedValue([]),
          removeRepeatableByKey: jest.fn()
        } as never;
      }
      return {
        add: maintAdd,
        getRepeatableJobs: jest.fn().mockResolvedValue([]),
        removeRepeatableByKey: jest.fn()
      } as never;
    }) as never);

    const service = createService();
    await service.start("worker");

    expect(aiAdd).toHaveBeenCalled();
    expect(maintAdd).toHaveBeenCalled();
  });

  it("reload removes existing repeatables and re-adds", async () => {
    const removeAi = jest.fn().mockResolvedValue(undefined);
    const removeMaint = jest.fn().mockResolvedValue(undefined);
    const aiAdd = jest.fn().mockResolvedValue({});
    const maintAdd = jest.fn().mockResolvedValue({});
    jest.spyOn(queues, "getQueue").mockImplementation(((name: queues.QueueName) => {
      if (name === "ai") {
        return {
          add: aiAdd,
          getRepeatableJobs: jest
            .fn()
            .mockResolvedValue([{ name: "schedule-health", key: "k1" }]),
          removeRepeatableByKey: removeAi
        } as never;
      }
      return {
        add: maintAdd,
        getRepeatableJobs: jest
          .fn()
          .mockResolvedValue([{ name: "schedule-retention", key: "k2" }]),
        removeRepeatableByKey: removeMaint
      } as never;
    }) as never);

    const service = createService();
    await service.start("worker");
    await service.reload();

    expect(removeAi).toHaveBeenCalledWith("k1");
    expect(removeMaint).toHaveBeenCalledWith("k2");
    expect(aiAdd).toHaveBeenCalled();
    expect(maintAdd).toHaveBeenCalled();
  });

  it("does not schedule briefing when LLM is disabled", async () => {
    process.env.LLM_ENABLED = "false";
    const aiAdd = jest.fn().mockResolvedValue({});
    jest.spyOn(queues, "getQueue").mockImplementation((() => {
      return {
        add: aiAdd,
        getRepeatableJobs: jest.fn().mockResolvedValue([]),
        removeRepeatableByKey: jest.fn()
      } as never;
    }) as never);

    const service = createService();
    await service.start("worker");

    const scheduledNames = aiAdd.mock.calls.map((call) => call[0]);
    expect(scheduledNames).not.toContain("schedule-briefing");
  });
});
