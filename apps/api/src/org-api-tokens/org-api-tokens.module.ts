import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { BillingModule } from "../billing/billing.module";
import { PrismaModule } from "../prisma/prisma.module";
import { OrgApiTokensController } from "./org-api-tokens.controller";
import { OrgApiTokensService } from "./org-api-tokens.service";

@Module({
  imports: [PrismaModule, AuthModule, BillingModule],
  controllers: [OrgApiTokensController],
  providers: [OrgApiTokensService]
})
export class OrgApiTokensModule {}
