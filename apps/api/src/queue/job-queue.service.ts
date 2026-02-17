import { Injectable } from "@nestjs/common";
import { JobsOptions } from "bullmq";
import { JobService } from "../jobs/job.service";
import { JobEnqueueResult } from "../jobs/job.types";
import { QueueName } from "../jobs/queues";

@Injectable()
export class JobQueueService {
  constructor(private readonly jobService: JobService) {}

  enqueue(
    queueName: QueueName,
    jobName: string,
    payload: Record<string, unknown>,
    options?: JobsOptions
  ): Promise<JobEnqueueResult> {
    return this.jobService.enqueue(queueName, jobName as never, payload, options);
  }

  runNow(queueName: QueueName, jobName: string, payload: Record<string, unknown>) {
    return this.jobService.runNow(queueName, jobName as never, payload);
  }
}

