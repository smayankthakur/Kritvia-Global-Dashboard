import { Module } from "@nestjs/common";
import { ActivityLogModule } from "../activity-log/activity-log.module";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { FixActionsController } from "./fix-actions.controller";
import { FixActionsService } from "./fix-actions.service";

@Module({
  imports: [PrismaModule, AuthModule, ActivityLogModule],
  controllers: [FixActionsController],
  providers: [FixActionsService],
  exports: [FixActionsService]
})
export class FixActionsModule {}
