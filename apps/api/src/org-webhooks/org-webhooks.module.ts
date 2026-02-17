import { Module } from "@nestjs/common";
import { AlertsModule } from "../alerts/alerts.module";
import { AuthModule } from "../auth/auth.module";
import { BillingModule } from "../billing/billing.module";
import { JobsModule } from "../jobs/jobs.module";
import { PrismaModule } from "../prisma/prisma.module";
import { OrgWebhooksController } from "./org-webhooks.controller";
import { OrgWebhooksService } from "./org-webhooks.service";
import { WebhookService } from "./webhook.service";

@Module({
  imports: [PrismaModule, AuthModule, BillingModule, JobsModule, AlertsModule],
  controllers: [OrgWebhooksController],
  providers: [OrgWebhooksService, WebhookService],
  exports: [WebhookService]
})
export class OrgWebhooksModule {}
