import { Body, Controller, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Role } from "@prisma/client";
import { AuthUserContext } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { getActiveOrgId } from "../common/auth-org";
import { assertFeatureEnabled } from "../common/feature-flags";
import { JobQueueService } from "../queue/job-queue.service";
import { GenerateCeoDailyBriefDto } from "./dto/generate-ceo-daily-brief.dto";
import { ListLlmReportsDto } from "./dto/list-llm-reports.dto";
import { LlmService } from "./llm.service";

@Controller("llm/reports")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.CEO, Role.ADMIN)
export class LlmController {
  constructor(
    private readonly llmService: LlmService,
    private readonly jobQueueService: JobQueueService
  ) {}

  @Post("ceo-daily-brief")
  @Throttle({ default: { limit: 10, ttl: 3600000 } })
  async generateCeoDailyBrief(
    @Req() req: { user: AuthUserContext },
    @Body() body: GenerateCeoDailyBriefDto
  ) {
    assertFeatureEnabled("FEATURE_AI_ENABLED");
    const orgId = getActiveOrgId(req);
    const periodDays = body.periodDays ?? 7;
    return this.jobQueueService.enqueueAndWait("llm-ceo-daily-brief", () =>
      this.llmService.generateCeoDailyBrief(orgId, req.user.userId, periodDays)
    );
  }

  @Post("score-drop-explain")
  @Throttle({ default: { limit: 10, ttl: 3600000 } })
  async generateScoreDropExplain(@Req() req: { user: AuthUserContext }) {
    assertFeatureEnabled("FEATURE_AI_ENABLED");
    const orgId = getActiveOrgId(req);
    return this.jobQueueService.enqueueAndWait("llm-score-drop-explain", () =>
      this.llmService.generateScoreDropExplain(orgId, req.user.userId)
    );
  }

  @Get()
  async listReports(@Req() req: { user: AuthUserContext }, @Query() query: ListLlmReportsDto) {
    assertFeatureEnabled("FEATURE_AI_ENABLED");
    const orgId = getActiveOrgId(req);
    return this.llmService.listReports(orgId, query);
  }
}
