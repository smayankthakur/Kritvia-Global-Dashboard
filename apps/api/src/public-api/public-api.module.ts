import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PrismaModule } from "../prisma/prisma.module";
import { PublicApiController } from "./public-api.controller";
import { PublicApiVersionInterceptor } from "./public-api-version.interceptor";
import { PublicApiService } from "./public-api.service";
import { ServiceAccountOnlyGuard } from "./service-account-only.guard";

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [PublicApiController],
  providers: [PublicApiService, ServiceAccountOnlyGuard, PublicApiVersionInterceptor]
})
export class PublicApiModule {}
