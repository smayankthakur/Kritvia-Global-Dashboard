import { Module } from "@nestjs/common";
import { ActivityLogModule } from "../activity-log/activity-log.module";
import { AuthModule } from "../auth/auth.module";
import { BillingModule } from "../billing/billing.module";
import { OauthModule } from "../oauth/oauth.module";
import { OrgWebhooksModule } from "../org-webhooks/org-webhooks.module";
import { PrismaModule } from "../prisma/prisma.module";
import { MarketplaceController } from "./marketplace.controller";
import { MarketplaceService } from "./marketplace.service";
import { OrgAppsController } from "./org-apps.controller";
import { OrgAppsService } from "./org-apps.service";

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    BillingModule,
    ActivityLogModule,
    OauthModule,
    OrgWebhooksModule
  ],
  controllers: [MarketplaceController, OrgAppsController],
  providers: [MarketplaceService, OrgAppsService],
  exports: [MarketplaceService, OrgAppsService]
})
export class MarketplaceModule {}
