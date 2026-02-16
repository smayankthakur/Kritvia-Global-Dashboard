import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { BillingModule } from "../billing/billing.module";
import { PrismaModule } from "../prisma/prisma.module";
import { RevenueVelocityController } from "./revenue-velocity.controller";
import { RevenueVelocityService } from "./revenue-velocity.service";

@Module({
  imports: [PrismaModule, AuthModule, BillingModule],
  controllers: [RevenueVelocityController],
  providers: [RevenueVelocityService]
})
export class RevenueVelocityModule {}
