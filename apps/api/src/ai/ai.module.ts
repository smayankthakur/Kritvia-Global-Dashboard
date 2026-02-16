import { Module } from "@nestjs/common";
import { ActivityLogModule } from "../activity-log/activity-log.module";
import { AuthModule } from "../auth/auth.module";
import { BillingModule } from "../billing/billing.module";
import { OrgWebhooksModule } from "../org-webhooks/org-webhooks.module";
import { PrismaModule } from "../prisma/prisma.module";
import { QueueModule } from "../queue/queue.module";
import { AiController } from "./ai.controller";
import { AiService } from "./ai.service";

@Module({
  imports: [
    PrismaModule,
    BillingModule,
    AuthModule,
    ActivityLogModule,
    OrgWebhooksModule,
    QueueModule
  ],
  controllers: [AiController],
  providers: [AiService],
  exports: [AiService]
})
export class AiModule {}
