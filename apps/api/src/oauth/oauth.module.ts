import { Module } from "@nestjs/common";
import { ActivityLogModule } from "../activity-log/activity-log.module";
import { BillingModule } from "../billing/billing.module";
import { PrismaModule } from "../prisma/prisma.module";
import { OAuthController } from "./oauth.controller";
import { OAuthProviderFactory } from "./oauth-provider.factory";
import { OAuthService } from "./oauth.service";
import { OAuthStateService } from "./oauth-state.service";

@Module({
  imports: [PrismaModule, BillingModule, ActivityLogModule],
  controllers: [OAuthController],
  providers: [OAuthProviderFactory, OAuthStateService, OAuthService],
  exports: [OAuthProviderFactory, OAuthStateService, OAuthService]
})
export class OauthModule {}
