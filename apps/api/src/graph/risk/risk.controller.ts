import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { Role } from "@prisma/client";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard";
import { AuthUserContext } from "../../auth/auth.types";
import { Roles } from "../../auth/roles.decorator";
import { RolesGuard } from "../../auth/roles.guard";
import { getActiveOrgId } from "../../common/auth-org";
import { assertFeatureEnabled } from "../../common/feature-flags";
import { AutoNudgeService } from "./auto-nudge.service";
import { RecomputeRiskDto } from "./dto/recompute-risk.dto";
import { RiskEngineService } from "./risk-engine.service";

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class RiskController {
  constructor(
    private readonly riskEngineService: RiskEngineService,
    private readonly autoNudgeService: AutoNudgeService
  ) {}

  @Post("graph/risk/recompute")
  @Roles(Role.CEO, Role.ADMIN)
  async recompute(
    @Req() req: { user: AuthUserContext },
    @Body() body: RecomputeRiskDto
  ) {
    assertFeatureEnabled("FEATURE_RISK_ENGINE");
    const orgId = getActiveOrgId(req);
    const computed = await this.riskEngineService.computeOrgRisk(orgId, {
      maxNodes: body.maxNodes
    });

    return {
      orgRiskScore: computed.orgRiskScore,
      topDrivers: computed.topDrivers,
      updatedNodesCount: computed.nodeUpdates.length
    };
  }

  @Get("ceo/risk")
  @Roles(Role.CEO, Role.ADMIN, Role.OPS)
  async getRisk(@Req() req: { user: AuthUserContext }) {
    assertFeatureEnabled("FEATURE_RISK_ENGINE");
    const orgId = getActiveOrgId(req);
    return this.riskEngineService.getLatestRisk(orgId);
  }

  @Get("ceo/risk/why")
  @Roles(Role.CEO, Role.ADMIN, Role.OPS)
  async getWhy(@Req() req: { user: AuthUserContext }) {
    assertFeatureEnabled("FEATURE_RISK_ENGINE");
    const orgId = getActiveOrgId(req);
    return this.riskEngineService.getRiskWhy(orgId);
  }

  @Get("ceo/risk/nudges")
  @Roles(Role.CEO, Role.ADMIN, Role.OPS)
  async getRiskNudges(@Req() req: { user: AuthUserContext }) {
    assertFeatureEnabled("FEATURE_RISK_ENGINE");
    const orgId = getActiveOrgId(req);
    return this.autoNudgeService.listRecentRiskNudges(orgId);
  }

  @Post("graph/risk/generate-nudges-now")
  @Roles(Role.CEO, Role.ADMIN)
  async generateRiskNudgesNow(@Req() req: { user: AuthUserContext }) {
    assertFeatureEnabled("FEATURE_RISK_ENGINE");
    assertFeatureEnabled("FEATURE_RISK_AUTO_NUDGES");
    const orgId = getActiveOrgId(req);
    return this.autoNudgeService.generateFromLatestSnapshot(orgId);
  }
}
