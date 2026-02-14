import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { Role } from "@prisma/client";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AuthUserContext } from "../auth/auth.types";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { ExplainHealthScoreQueryDto } from "./dto/explain-health-score-query.dto";
import { HealthScoreService } from "./health-score.service";

@Controller("ceo")
@UseGuards(JwtAuthGuard, RolesGuard)
export class HealthScoreController {
  constructor(private readonly healthScoreService: HealthScoreService) {}

  @Get("health-score")
  @Roles(Role.CEO, Role.ADMIN)
  async getHealthScore(@Req() req: { user: AuthUserContext }) {
    return this.healthScoreService.getOrComputeForUser(req.user);
  }

  @Get("health-score/explain")
  @Roles(Role.CEO, Role.ADMIN)
  async getHealthScoreExplanation(
    @Req() req: { user: AuthUserContext },
    @Query() query: ExplainHealthScoreQueryDto
  ) {
    return this.healthScoreService.explainForUser(req.user, query.date);
  }
}
