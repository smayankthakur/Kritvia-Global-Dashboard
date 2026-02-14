import { Global, Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ShieldController } from "./shield.controller";
import { ShieldService } from "./shield.service";

@Global()
@Module({
  imports: [AuthModule],
  controllers: [ShieldController],
  providers: [ShieldService],
  exports: [ShieldService]
})
export class ShieldModule {}
