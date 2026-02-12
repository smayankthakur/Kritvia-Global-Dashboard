import { Module } from "@nestjs/common";
import { ActivityLogModule } from "../activity-log/activity-log.module";
import { AuthModule } from "../auth/auth.module";
import { LeadsController } from "./leads.controller";
import { LeadsService } from "./leads.service";

@Module({
  imports: [ActivityLogModule, AuthModule],
  controllers: [LeadsController],
  providers: [LeadsService]
})
export class LeadsModule {}
