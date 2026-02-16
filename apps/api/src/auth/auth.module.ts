import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { ActivityLogModule } from "../activity-log/activity-log.module";
import { PrismaModule } from "../prisma/prisma.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { RolesGuard } from "./roles.guard";
import { TokenScopeGuard } from "./token-scope.guard";

@Module({
  imports: [JwtModule.register({}), ActivityLogModule, PrismaModule],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, RolesGuard, TokenScopeGuard],
  exports: [JwtModule, JwtAuthGuard, RolesGuard, TokenScopeGuard]
})
export class AuthModule {}
