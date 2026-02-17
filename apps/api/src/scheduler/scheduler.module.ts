import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { HealthScoreModule } from "../health-score/health-score.module";
import { JobsModule } from "../jobs/jobs.module";
import { PrismaModule } from "../prisma/prisma.module";
import { SchedulerController } from "./scheduler.controller";
import { SchedulerService } from "./scheduler.service";

@Module({
  imports: [PrismaModule, JobsModule, HealthScoreModule, AuthModule],
  controllers: [SchedulerController],
  providers: [SchedulerService],
  exports: [SchedulerService]
})
export class SchedulerModule {}
