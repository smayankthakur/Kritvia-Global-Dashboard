import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { ActivityLogModule } from "../activity-log/activity-log.module";
import { AuthModule } from "../auth/auth.module";
import { BillingModule } from "../billing/billing.module";
import { PrismaModule } from "../prisma/prisma.module";
import { OrgMembersController } from "./org-members.controller";
import { OrgMembersService } from "./org-members.service";

@Module({
  imports: [PrismaModule, AuthModule, ActivityLogModule, BillingModule, JwtModule.register({})],
  controllers: [OrgMembersController],
  providers: [OrgMembersService]
})
export class OrgMembersModule {}
