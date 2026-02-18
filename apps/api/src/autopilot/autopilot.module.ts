import { Module } from "@nestjs/common";
import { ActivityLogModule } from "../activity-log/activity-log.module";
import { AuthModule } from "../auth/auth.module";
import { FixActionsModule } from "../fix-actions/fix-actions.module";
import { PolicyModule } from "../policy/policy.module";
import { PrismaModule } from "../prisma/prisma.module";
import { AutopilotController } from "./autopilot.controller";
import { AutopilotService } from "./autopilot.service";

@Module({
  imports: [PrismaModule, AuthModule, PolicyModule, FixActionsModule, ActivityLogModule],
  controllers: [AutopilotController],
  providers: [AutopilotService],
  exports: [AutopilotService]
})
export class AutopilotModule {}
