import { Controller, Get, Param, ParseUUIDPipe, Patch, Query, Req, UseGuards } from "@nestjs/common";
import { Role } from "@prisma/client";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AuthUserContext } from "../auth/auth.types";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { ListSecurityEventsDto } from "./dto/list-security-events.dto";
import { ShieldService } from "./shield.service";

@Controller("shield")
@UseGuards(JwtAuthGuard, RolesGuard)
export class ShieldController {
  constructor(private readonly shieldService: ShieldService) {}

  @Get("events")
  @Roles(Role.CEO, Role.ADMIN)
  async listEvents(@Req() req: { user: AuthUserContext }, @Query() query: ListSecurityEventsDto) {
    return this.shieldService.listEvents(req.user, query);
  }

  @Patch("events/:id/resolve")
  @Roles(Role.CEO, Role.ADMIN)
  async resolveEvent(
    @Req() req: { user: AuthUserContext },
    @Param("id", ParseUUIDPipe) id: string
  ) {
    return this.shieldService.resolveEvent(req.user, id);
  }
}
