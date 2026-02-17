import { JobService } from "./job.service";
import * as queues from "./queues";

describe("JobService", () => {
  it("enqueue uses retries/backoff defaults", async () => {
    const add = jest.fn().mockResolvedValue({ id: "123" });
    jest.spyOn(queues, "getQueue").mockReturnValue({
      add
    } as unknown as ReturnType<typeof queues.getQueue>);

    const service = new JobService();
    const result = await service.enqueue("ai", "compute-insights", { orgId: "org-1" });

    expect(result).toEqual({
      queue: "ai",
      jobId: "123",
      status: "queued"
    });
    expect(add).toHaveBeenCalledWith(
      "compute-insights",
      { orgId: "org-1" },
      expect.objectContaining({
        attempts: 5,
        removeOnComplete: true,
        removeOnFail: false,
        backoff: expect.objectContaining({
          type: "exponential",
          delay: 10_000
        })
      })
    );
  });
});

