import { Module } from "@nestjs/common";
import { ActivityLogModule } from "../activity-log/activity-log.module";
import { AuthModule } from "../auth/auth.module";
import { OnCallModule } from "../oncall/oncall.module";
import { PrismaModule } from "../prisma/prisma.module";
import { IncidentsController } from "./incidents.controller";
import { IncidentsService } from "./incidents.service";

@Module({
  imports: [PrismaModule, AuthModule, OnCallModule, ActivityLogModule],
  controllers: [IncidentsController],
  providers: [IncidentsService],
  exports: [IncidentsService]
})
export class IncidentsModule {}
