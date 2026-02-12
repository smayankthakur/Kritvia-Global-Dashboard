import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { ActivityLogModule } from "../activity-log/activity-log.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { RolesGuard } from "./roles.guard";

@Module({
  imports: [JwtModule.register({}), ActivityLogModule],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, RolesGuard],
  exports: [JwtModule, JwtAuthGuard, RolesGuard]
})
export class AuthModule {}
