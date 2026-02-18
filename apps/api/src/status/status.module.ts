import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { OrgStatusController } from "./org-status.controller";
import { StatusAuthController } from "./status-auth.controller";
import { StatusController } from "./status.controller";
import { StatusService } from "./status.service";

@Module({
  imports: [PrismaModule],
  controllers: [StatusController, OrgStatusController, StatusAuthController],
  providers: [StatusService],
  exports: [StatusService]
})
export class StatusModule {}
