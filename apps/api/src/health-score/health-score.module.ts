import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { HealthScoreController } from "./health-score.controller";
import { HealthScoreJobsController } from "./health-score-jobs.controller";
import { HealthScoreService } from "./health-score.service";

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [HealthScoreController, HealthScoreJobsController],
  providers: [HealthScoreService]
})
export class HealthScoreModule {}
