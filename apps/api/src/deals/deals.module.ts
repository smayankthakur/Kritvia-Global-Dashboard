import { Module } from "@nestjs/common";
import { ActivityLogModule } from "../activity-log/activity-log.module";
import { AuthModule } from "../auth/auth.module";
import { DealsController } from "./deals.controller";
import { DealsService } from "./deals.service";

@Module({
  imports: [ActivityLogModule, AuthModule],
  controllers: [DealsController],
  providers: [DealsService]
})
export class DealsModule {}
