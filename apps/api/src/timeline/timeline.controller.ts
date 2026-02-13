import { Controller, Get, Param, ParseUUIDPipe, Req, UseGuards } from "@nestjs/common";
import { Role } from "@prisma/client";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AuthUserContext } from "../auth/auth.types";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { TimelineService } from "./timeline.service";

@Controller("deals")
@UseGuards(JwtAuthGuard, RolesGuard)
export class TimelineController {
  constructor(private readonly timelineService: TimelineService) {}

  @Get(":id/timeline")
  @Roles(Role.ADMIN, Role.CEO, Role.OPS, Role.SALES, Role.FINANCE)
  async getDealTimeline(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: { user: AuthUserContext }
  ) {
    return this.timelineService.getDealTimeline(id, req.user);
  }
}

