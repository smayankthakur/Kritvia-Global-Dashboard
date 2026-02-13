import { Controller, Post, Req, UseGuards } from "@nestjs/common";
import { Role } from "@prisma/client";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AuthUserContext } from "../auth/auth.types";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { HealthScoreService } from "./health-score.service";

@Controller("jobs")
@UseGuards(JwtAuthGuard, RolesGuard)
export class HealthScoreJobsController {
  constructor(private readonly healthScoreService: HealthScoreService) {}

  @Post("compute-health-score")
  @Roles(Role.ADMIN)
  async computeHealthScore(@Req() req: { user: AuthUserContext }) {
    return this.healthScoreService.computeForUser(req.user);
  }
}
