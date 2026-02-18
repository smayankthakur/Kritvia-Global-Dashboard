import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { OrgStatusController } from "./org-status.controller";
import { StatusAuthController } from "./status-auth.controller";
import { StatusController } from "./status.controller";
import { StatusService } from "./status.service";

@Module({
  // Import AuthModule so JwtAuthGuard dependencies (JwtService, PrismaService) resolve in this context.
  imports: [PrismaModule, AuthModule],
  controllers: [StatusController, OrgStatusController, StatusAuthController],
  providers: [StatusService],
  exports: [StatusService]
})
export class StatusModule {}
