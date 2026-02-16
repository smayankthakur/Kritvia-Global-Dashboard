import { Module } from "@nestjs/common";
import { ActivityLogModule } from "../activity-log/activity-log.module";
import { AuthModule } from "../auth/auth.module";
import { DealsModule } from "../deals/deals.module";
import { NudgesModule } from "../nudges/nudges.module";
import { PrismaModule } from "../prisma/prisma.module";
import { WorkItemsModule } from "../work-items/work-items.module";
import { AppCommandsController } from "./app-commands.controller";
import { AppCommandsService } from "./app-commands.service";
import { PublicApiController } from "./public-api.controller";
import { PublicApiVersionInterceptor } from "./public-api-version.interceptor";
import { PublicApiService } from "./public-api.service";
import { ServiceAccountOnlyGuard } from "./service-account-only.guard";

@Module({
  imports: [
    AuthModule,
    PrismaModule,
    ActivityLogModule,
    NudgesModule,
    WorkItemsModule,
    DealsModule
  ],
  controllers: [PublicApiController, AppCommandsController],
  providers: [PublicApiService, AppCommandsService, ServiceAccountOnlyGuard, PublicApiVersionInterceptor]
})
export class PublicApiModule {}
