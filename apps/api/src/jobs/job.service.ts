import { Injectable } from "@nestjs/common";
import { JobsOptions } from "bullmq";
import { QueueName, QUEUE_NAMES, getQueue, withDefaultJobOptions } from "./queues";
import { JobEnqueueResult, JobName } from "./job.types";

@Injectable()
export class JobService {
  enqueue(
    queueName: QueueName,
    jobName: JobName,
    payload: Record<string, unknown>,
    options?: JobsOptions
  ): Promise<JobEnqueueResult> {
    if ((process.env.JOBS_ENABLED ?? "true").toLowerCase() !== "true") {
      // Keep a non-breaking response shape in disabled mode.
      return Promise.resolve({
        queue: queueName,
        jobId: `jobs-disabled-${Date.now()}`,
        status: "queued"
      });
    }

    const queue = getQueue(queueName);
    return queue
      .add(jobName, payload, withDefaultJobOptions(options))
      .then((job) => ({
        queue: queueName,
        jobId: job.id?.toString() ?? "unknown",
        status: "queued" as const
      }));
  }

  runNow(queueName: QueueName, jobName: JobName, payload: Record<string, unknown>) {
    return this.enqueue(queueName, jobName, payload, {
      priority: 1
    });
  }

  async getStatus(queueName: QueueName, jobId: string) {
    const queue = getQueue(queueName);
    const job = await queue.getJob(jobId);
    if (!job) {
      return null;
    }

    const state = await job.getState();
    return {
      queue: queueName,
      jobId: job.id?.toString() ?? jobId,
      name: job.name,
      state,
      attemptsMade: job.attemptsMade,
      failedReason: job.failedReason ?? null,
      processedOn: job.processedOn ?? null,
      finishedOn: job.finishedOn ?? null
    };
  }

  async getFailed(queueName: QueueName, start = 0, end = 50) {
    const queue = getQueue(queueName);
    const failed = await queue.getJobs(["failed"], start, end, true);
    return failed.map((job) => ({
      queue: queueName,
      jobId: job.id?.toString() ?? "unknown",
      name: job.name,
      failedReason: job.failedReason ?? null,
      attemptsMade: job.attemptsMade,
      timestamp: job.timestamp
    }));
  }

  async getStats() {
    const queues = [
      QUEUE_NAMES.ai,
      QUEUE_NAMES.webhooks,
      QUEUE_NAMES.maintenance,
      QUEUE_NAMES.dlq,
      QUEUE_NAMES.alerts
    ] as const;
    const stats = await Promise.all(
      queues.map(async (queueName) => {
        const queue = getQueue(queueName);
        const [waiting, active, completed, failed, delayed] = await Promise.all([
          queue.getWaitingCount(),
          queue.getActiveCount(),
          queue.getCompletedCount(),
          queue.getFailedCount(),
          queue.getDelayedCount()
        ]);
        return {
          queue: queueName,
          waiting,
          active,
          completed,
          failed,
          delayed
        };
      })
    );
    return { queues: stats };
  }
}
