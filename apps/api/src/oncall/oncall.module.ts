import { Module } from "@nestjs/common";
import { ActivityLogModule } from "../activity-log/activity-log.module";
import { AuthModule } from "../auth/auth.module";
import { BillingModule } from "../billing/billing.module";
import { PrismaModule } from "../prisma/prisma.module";
import { OnCallHolidaysController } from "./oncall-holidays.controller";
import { OnCallController } from "./oncall.controller";
import { OnCallResolver } from "./oncall.resolver";
import { OnCallService } from "./oncall.service";

@Module({
  imports: [PrismaModule, AuthModule, BillingModule, ActivityLogModule],
  controllers: [OnCallController, OnCallHolidaysController],
  providers: [OnCallService, OnCallResolver],
  exports: [OnCallResolver]
})
export class OnCallModule {}
