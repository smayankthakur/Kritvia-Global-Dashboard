import { Module } from "@nestjs/common";
import { ActivityLogModule } from "../activity-log/activity-log.module";
import { AuthModule } from "../auth/auth.module";
import { BillingModule } from "../billing/billing.module";
import { OrgWebhooksModule } from "../org-webhooks/org-webhooks.module";
import { PrismaModule } from "../prisma/prisma.module";
import { AiActionsController } from "./ai-actions.controller";
import { AiActionsService } from "./ai-actions.service";

@Module({
  imports: [PrismaModule, AuthModule, BillingModule, ActivityLogModule, OrgWebhooksModule],
  controllers: [AiActionsController],
  providers: [AiActionsService],
  exports: [AiActionsService]
})
export class AiActionsModule {}
