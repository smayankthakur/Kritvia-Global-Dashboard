import { Body, Controller, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Role } from "@prisma/client";
import { AuthUserContext } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { getActiveOrgId } from "../common/auth-org";
import { GenerateCeoDailyBriefDto } from "./dto/generate-ceo-daily-brief.dto";
import { ListLlmReportsDto } from "./dto/list-llm-reports.dto";
import { LlmService } from "./llm.service";

@Controller("llm/reports")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.CEO, Role.ADMIN)
export class LlmController {
  constructor(private readonly llmService: LlmService) {}

  @Post("ceo-daily-brief")
  @Throttle({ default: { limit: 10, ttl: 3600000 } })
  async generateCeoDailyBrief(
    @Req() req: { user: AuthUserContext },
    @Body() body: GenerateCeoDailyBriefDto
  ) {
    const orgId = getActiveOrgId(req);
    const periodDays = body.periodDays ?? 7;
    return this.llmService.generateCeoDailyBrief(orgId, req.user.userId, periodDays);
  }

  @Post("score-drop-explain")
  @Throttle({ default: { limit: 10, ttl: 3600000 } })
  async generateScoreDropExplain(@Req() req: { user: AuthUserContext }) {
    const orgId = getActiveOrgId(req);
    return this.llmService.generateScoreDropExplain(orgId, req.user.userId);
  }

  @Get()
  async listReports(@Req() req: { user: AuthUserContext }, @Query() query: ListLlmReportsDto) {
    const orgId = getActiveOrgId(req);
    return this.llmService.listReports(orgId, query);
  }
}
