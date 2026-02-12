import { Module } from "@nestjs/common";
import { ActivityLogModule } from "../activity-log/activity-log.module";
import { AuthModule } from "../auth/auth.module";
import { WorkItemsController } from "./work-items.controller";
import { WorkItemsService } from "./work-items.service";

@Module({
  imports: [ActivityLogModule, AuthModule],
  controllers: [WorkItemsController],
  providers: [WorkItemsService]
})
export class WorkItemsModule {}
