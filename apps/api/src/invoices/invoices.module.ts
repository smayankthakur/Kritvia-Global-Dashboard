import { Module } from "@nestjs/common";
import { ActivityLogModule } from "../activity-log/activity-log.module";
import { AuthModule } from "../auth/auth.module";
import { BillingModule } from "../billing/billing.module";
import { GraphModule } from "../graph/graph.module";
import { OrgWebhooksModule } from "../org-webhooks/org-webhooks.module";
import { PolicyModule } from "../policy/policy.module";
import { InvoicesController } from "./invoices.controller";
import { InvoicesService } from "./invoices.service";

@Module({
  imports: [ActivityLogModule, AuthModule, PolicyModule, BillingModule, OrgWebhooksModule, GraphModule],
  controllers: [InvoicesController],
  providers: [InvoicesService]
})
export class InvoicesModule {}
