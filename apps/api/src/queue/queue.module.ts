import { Module } from "@nestjs/common";
import { JobsModule } from "../jobs/jobs.module";
import { JobQueueService } from "./job-queue.service";

@Module({
  imports: [JobsModule],
  providers: [JobQueueService],
  exports: [JobQueueService]
})
export class QueueModule {}
