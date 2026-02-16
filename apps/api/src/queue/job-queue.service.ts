import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";

interface QueueTask<T = unknown> {
  id: string;
  name: string;
  handler: () => Promise<T>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

@Injectable()
export class JobQueueService {
  private readonly logger = new Logger(JobQueueService.name);
  private readonly queue: QueueTask[] = [];
  private processing = false;

  enqueue<T>(name: string, handler: () => Promise<T>): { jobId: string; promise: Promise<T> } {
    const jobId = randomUUID();
    const promise = new Promise<T>((resolve, reject) => {
      this.queue.push({
        id: jobId,
        name,
        handler,
        resolve: resolve as (value: unknown) => void,
        reject
      });
      this.scheduleDrain();
    });

    return { jobId, promise };
  }

  async enqueueAndWait<T>(name: string, handler: () => Promise<T>): Promise<T> {
    const queued = this.enqueue(name, handler);
    return queued.promise;
  }

  private scheduleDrain(): void {
    if (this.processing) {
      return;
    }
    this.processing = true;
    void this.drainQueue();
  }

  private async drainQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) {
        continue;
      }

      const startedAt = Date.now();
      try {
        const result = await task.handler();
        task.resolve(result);
        this.logger.log(
          JSON.stringify({
            event: "job_processed",
            jobId: task.id,
            name: task.name,
            durationMs: Date.now() - startedAt
          })
        );
      } catch (error) {
        task.reject(error);
        this.logger.error(
          JSON.stringify({
            event: "job_failed",
            jobId: task.id,
            name: task.name,
            durationMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : "Unknown job error"
          })
        );
      }
    }
    this.processing = false;
  }
}
