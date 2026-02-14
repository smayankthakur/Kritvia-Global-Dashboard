import { Body, Controller, Get, Put, Req, UseGuards } from "@nestjs/common";
import { Role } from "@prisma/client";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AuthUserContext } from "../auth/auth.types";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { UpdatePolicyDto } from "./dto/update-policy.dto";
import { SettingsService } from "./settings.service";

@Controller("settings")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.CEO, Role.ADMIN)
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get("policies")
  async getPolicies(@Req() req: { user: AuthUserContext }) {
    return this.settingsService.getPolicies(req.user);
  }

  @Put("policies")
  async updatePolicies(
    @Req() req: { user: AuthUserContext },
    @Body() dto: UpdatePolicyDto
  ) {
    return this.settingsService.updatePolicies(req.user, dto);
  }
}
