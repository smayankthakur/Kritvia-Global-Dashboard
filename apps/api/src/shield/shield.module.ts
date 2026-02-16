import { Global, Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { BillingModule } from "../billing/billing.module";
import { ShieldController } from "./shield.controller";
import { ShieldService } from "./shield.service";

@Global()
@Module({
  imports: [AuthModule, BillingModule],
  controllers: [ShieldController],
  providers: [ShieldService],
  exports: [ShieldService]
})
export class ShieldModule {}
