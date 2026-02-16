import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { Role } from "@prisma/client";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AuthUserContext } from "../auth/auth.types";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { RevenueVelocityService } from "./revenue-velocity.service";

@Controller("ceo/revenue")
@UseGuards(JwtAuthGuard, RolesGuard)
export class RevenueVelocityController {
  constructor(private readonly revenueVelocityService: RevenueVelocityService) {}

  @Get("velocity")
  @Roles(Role.CEO, Role.ADMIN)
  async getRevenueVelocity(@Req() req: { user: AuthUserContext }) {
    return this.revenueVelocityService.getRevenueVelocity(req.user);
  }

  @Get("cashflow")
  @Roles(Role.CEO, Role.ADMIN)
  async getCashflowForecast(@Req() req: { user: AuthUserContext }) {
    return this.revenueVelocityService.getCashflowForecast(req.user);
  }
}
