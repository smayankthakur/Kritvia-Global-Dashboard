import { Module } from "@nestjs/common";
import { ActivityLogModule } from "../activity-log/activity-log.module";
import { AuthModule } from "../auth/auth.module";
import { PolicyModule } from "../policy/policy.module";
import { DealsController } from "./deals.controller";
import { DealsService } from "./deals.service";

@Module({
  imports: [ActivityLogModule, AuthModule, PolicyModule],
  controllers: [DealsController],
  providers: [DealsService]
})
export class DealsModule {}
