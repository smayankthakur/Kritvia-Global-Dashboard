import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { HygieneController } from "./hygiene.controller";
import { HygieneService } from "./hygiene.service";

@Module({
  imports: [AuthModule],
  controllers: [HygieneController],
  providers: [HygieneService]
})
export class HygieneModule {}
