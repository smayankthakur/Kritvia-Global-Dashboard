import { Module } from "@nestjs/common";
import { ActivityLogModule } from "../activity-log/activity-log.module";
import { AuthModule } from "../auth/auth.module";
import { InvoicesController } from "./invoices.controller";
import { InvoicesService } from "./invoices.service";

@Module({
  imports: [ActivityLogModule, AuthModule],
  controllers: [InvoicesController],
  providers: [InvoicesService]
})
export class InvoicesModule {}
