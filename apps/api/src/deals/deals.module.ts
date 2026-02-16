import { Module } from "@nestjs/common";
import { ActivityLogModule } from "../activity-log/activity-log.module";
import { AuthModule } from "../auth/auth.module";
import { OrgWebhooksModule } from "../org-webhooks/org-webhooks.module";
import { PolicyModule } from "../policy/policy.module";
import { DealsController } from "./deals.controller";
import { DealsService } from "./deals.service";

@Module({
  imports: [ActivityLogModule, AuthModule, PolicyModule, OrgWebhooksModule],
  controllers: [DealsController],
  providers: [DealsService],
  exports: [DealsService]
})
export class DealsModule {}
