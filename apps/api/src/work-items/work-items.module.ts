import { Module } from "@nestjs/common";
import { ActivityLogModule } from "../activity-log/activity-log.module";
import { AuthModule } from "../auth/auth.module";
import { BillingModule } from "../billing/billing.module";
import { OrgWebhooksModule } from "../org-webhooks/org-webhooks.module";
import { PolicyModule } from "../policy/policy.module";
import { WorkItemsController } from "./work-items.controller";
import { WorkItemsService } from "./work-items.service";

@Module({
  imports: [ActivityLogModule, AuthModule, PolicyModule, BillingModule, OrgWebhooksModule],
  controllers: [WorkItemsController],
  providers: [WorkItemsService],
  exports: [WorkItemsService]
})
export class WorkItemsModule {}
