import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { TimelineController } from "./timeline.controller";
import { TimelineService } from "./timeline.service";

@Module({
  imports: [AuthModule],
  controllers: [TimelineController],
  providers: [TimelineService]
})
export class TimelineModule {}

