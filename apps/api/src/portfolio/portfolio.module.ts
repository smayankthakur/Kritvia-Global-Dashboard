import { Module } from "@nestjs/common";
import { ActivityLogModule } from "../activity-log/activity-log.module";
import { AuthModule } from "../auth/auth.module";
import { BillingModule } from "../billing/billing.module";
import { PrismaModule } from "../prisma/prisma.module";
import { PortfolioController } from "./portfolio.controller";
import { PortfolioService } from "./portfolio.service";

@Module({
  imports: [PrismaModule, AuthModule, ActivityLogModule, BillingModule],
  controllers: [PortfolioController],
  providers: [PortfolioService]
})
export class PortfolioModule {}
