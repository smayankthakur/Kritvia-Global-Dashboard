import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Role } from "@prisma/client";
import { AuthUserContext } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { getActiveOrgId } from "../common/auth-org";
import { ComputeImpactRadiusDto } from "./dto/compute-impact-radius.dto";
import { ImpactRadiusQueryDto } from "./dto/impact-radius-query.dto";
import { ImpactRadiusService } from "./impact-radius.service";

@Controller("graph")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.CEO, Role.ADMIN, Role.OPS)
export class ImpactRadiusController {
  constructor(private readonly impactRadiusService: ImpactRadiusService) {}

  @Post("impact-radius")
  async compute(
    @Req() req: { user: AuthUserContext },
    @Body() body: ComputeImpactRadiusDto
  ) {
    const orgId = getActiveOrgId(req);
    return this.impactRadiusService.computeImpactRadius(orgId, body.startNodeId, body);
  }

  @Get("impact-radius/node/:id")
  async computeByNode(
    @Req() req: { user: AuthUserContext },
    @Param("id") nodeId: string,
    @Query() query: ImpactRadiusQueryDto
  ) {
    const orgId = getActiveOrgId(req);
    return this.impactRadiusService.computeImpactRadius(orgId, nodeId, query);
  }

  @Get("deeplink/:nodeId")
  async deeplink(@Req() req: { user: AuthUserContext }, @Param("nodeId") nodeId: string) {
    const orgId = getActiveOrgId(req);
    return this.impactRadiusService.mapDeeplink(orgId, nodeId);
  }
}

