import { Module } from "@nestjs/common";
import { ActivityLogModule } from "../activity-log/activity-log.module";
import { AuthModule } from "../auth/auth.module";
import { FeedController } from "./feed.controller";
import { NudgesController } from "./nudges.controller";
import { NudgesService } from "./nudges.service";

@Module({
  imports: [ActivityLogModule, AuthModule],
  controllers: [NudgesController, FeedController],
  providers: [NudgesService],
  exports: [NudgesService]
})
export class NudgesModule {}
