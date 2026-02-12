import { Module } from "@nestjs/common";
import { ActivityLogModule } from "../activity-log/activity-log.module";
import { AuthModule } from "../auth/auth.module";
import { CompaniesController } from "./companies.controller";
import { CompaniesService } from "./companies.service";

@Module({
  imports: [ActivityLogModule, AuthModule],
  controllers: [CompaniesController],
  providers: [CompaniesService],
  exports: [CompaniesService]
})
export class CompaniesModule {}
