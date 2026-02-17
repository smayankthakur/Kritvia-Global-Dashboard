import { BadRequestException, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Role } from "@prisma/client";
import { AuthUserContext } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { getActiveOrgId } from "../common/auth-org";
import { SchedulerService } from "./scheduler.service";

@Controller("jobs")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class SchedulerController {
  constructor(private readonly schedulerService: SchedulerService) {}

  @Post("scheduler/reload")
  async reload() {
    return this.schedulerService.reload();
  }

  @Get("scheduler/status")
  async status() {
    return this.schedulerService.status();
  }

  @Post("run-once/:name")
  async runOnce(
    @Param("name") name: string,
    @Query("all") all: string | undefined,
    @Req() req: { user: AuthUserContext }
  ) {
    if (all === "true") {
      return this.schedulerService.handleScheduledTick(this.toScheduleName(name));
    }
    const orgId = getActiveOrgId(req);
    return this.schedulerService.runOnce(name, orgId);
  }

  private toScheduleName(name: string):
    | "schedule-health"
    | "schedule-insights"
    | "schedule-actions"
    | "schedule-briefing"
    | "schedule-invoice-scan"
    | "schedule-retention"
    | "schedule-escalation"
    | "schedule-uptime" {
    if (name === "health") return "schedule-health";
    if (name === "insights") return "schedule-insights";
    if (name === "actions") return "schedule-actions";
    if (name === "briefing") return "schedule-briefing";
    if (name === "invoice-scan") return "schedule-invoice-scan";
    if (name === "retention") return "schedule-retention";
    if (name === "escalation") return "schedule-escalation";
    if (name === "uptime") return "schedule-uptime";
    throw new BadRequestException("Unsupported run-once job name");
  }
}
