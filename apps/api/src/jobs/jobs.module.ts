import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ActivityLogModule } from "../activity-log/activity-log.module";
import { BillingModule } from "../billing/billing.module";
import { PolicyModule } from "../policy/policy.module";
import { DebugJobsController } from "./debug-jobs.controller";
import { JobService } from "./job.service";
import { JobsController } from "./jobs.controller";
import { JobsRunService } from "./jobs-run.service";

@Module({
  imports: [AuthModule, ActivityLogModule, PolicyModule, BillingModule],
  controllers: [JobsController, DebugJobsController],
  providers: [JobsRunService, JobService],
  exports: [JobService, JobsRunService]
})
export class JobsModule {}
