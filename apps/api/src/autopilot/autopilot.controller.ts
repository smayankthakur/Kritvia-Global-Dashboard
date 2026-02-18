import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Role } from "@prisma/client";
import { AuthUserContext } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { CreateAutopilotPolicyDto } from "./dto/create-policy.dto";
import { ListAutopilotRunsDto } from "./dto/list-runs.dto";
import { UpdateAutopilotPolicyDto } from "./dto/update-policy.dto";
import { AutopilotService } from "./autopilot.service";

@Controller("autopilot")
@UseGuards(JwtAuthGuard, RolesGuard)
export class AutopilotController {
  constructor(private readonly autopilotService: AutopilotService) {}

  @Get("policies")
  @Roles(Role.CEO, Role.ADMIN)
  async listPolicies(@Req() req: { user: AuthUserContext }) {
    return this.autopilotService.listPolicies(req.user);
  }

  @Post("policies")
  @Roles(Role.CEO, Role.ADMIN)
  async createPolicy(@Req() req: { user: AuthUserContext }, @Body() dto: CreateAutopilotPolicyDto) {
    return this.autopilotService.createPolicy(req.user, dto);
  }

  @Patch("policies/:id")
  @Roles(Role.CEO, Role.ADMIN)
  async updatePolicy(
    @Req() req: { user: AuthUserContext },
    @Param("id") id: string,
    @Body() dto: UpdateAutopilotPolicyDto
  ) {
    return this.autopilotService.updatePolicy(req.user, id, dto);
  }

  @Delete("policies/:id")
  @Roles(Role.CEO, Role.ADMIN)
  async deletePolicy(@Req() req: { user: AuthUserContext }, @Param("id") id: string) {
    return this.autopilotService.deletePolicy(req.user, id);
  }

  @Get("runs")
  @Roles(Role.CEO, Role.ADMIN, Role.OPS)
  async listRuns(@Req() req: { user: AuthUserContext }, @Query() query: ListAutopilotRunsDto) {
    return this.autopilotService.listRuns(req.user, query);
  }

  @Post("runs/:id/approve")
  @Roles(Role.CEO, Role.ADMIN)
  async approveRun(@Req() req: { user: AuthUserContext }, @Param("id") id: string) {
    return this.autopilotService.approveRun(req.user, id);
  }

  @Post("runs/:id/rollback")
  @Roles(Role.CEO, Role.ADMIN)
  async rollbackRun(@Req() req: { user: AuthUserContext }, @Param("id") id: string) {
    return this.autopilotService.rollbackRun(req.user, id);
  }
}
