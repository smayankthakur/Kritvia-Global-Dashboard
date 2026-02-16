import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { BillingModule } from "../billing/billing.module";
import { PrismaModule } from "../prisma/prisma.module";
import { OrgAuditController } from "./org-audit.controller";
import { OrgAuditService } from "./org-audit.service";

@Module({
  imports: [PrismaModule, AuthModule, BillingModule],
  controllers: [OrgAuditController],
  providers: [OrgAuditService]
})
export class OrgAuditModule {}
