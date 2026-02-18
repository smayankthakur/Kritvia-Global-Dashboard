import { Body, Controller, Get, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { Role } from "@prisma/client";
import { AuthUserContext } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { RequestStatusDomainDto } from "./dto/request-status-domain.dto";
import { UpdateStatusSettingsDto } from "./dto/update-status-settings.dto";
import { StatusService } from "./status.service";

@Controller("org/status")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.CEO, Role.ADMIN)
export class OrgStatusController {
  constructor(private readonly statusService: StatusService) {}

  @Get("settings")
  async getSettings(@Req() req: { user: AuthUserContext }) {
    return this.statusService.getStatusSettings(req.user);
  }

  @Patch("settings")
  async updateSettings(@Req() req: { user: AuthUserContext }, @Body() dto: UpdateStatusSettingsDto) {
    return this.statusService.updateStatusSettings(req.user, dto);
  }

  @Post("domain/request")
  async requestDomain(@Req() req: { user: AuthUserContext }, @Body() dto: RequestStatusDomainDto) {
    return this.statusService.requestCustomDomain(req.user, dto.domain);
  }

  @Post("domain/verify")
  async verifyDomain(@Req() req: { user: AuthUserContext }) {
    return this.statusService.verifyCustomDomain(req.user);
  }
}
