import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { Role } from "@prisma/client";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AuthUserContext } from "../auth/auth.types";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { DashboardService } from "./dashboard.service";

@Controller("dashboard")
@UseGuards(JwtAuthGuard, RolesGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get("ceo")
  @Roles(Role.CEO, Role.ADMIN)
  async getCeoDashboard(@Req() req: { user: AuthUserContext }) {
    return this.dashboardService.getCeoDashboard(req.user);
  }
}
