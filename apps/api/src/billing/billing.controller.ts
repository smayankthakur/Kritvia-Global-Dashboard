import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { Role } from "@prisma/client";
import { AuthUserContext } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { getActiveOrgId } from "../common/auth-org";
import { BillingService } from "./billing.service";

@Controller("billing")
@UseGuards(JwtAuthGuard, RolesGuard)
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Get("plan")
  @Roles(Role.CEO, Role.ADMIN)
  async getPlan(@Req() req: { user: AuthUserContext }) {
    const orgId = getActiveOrgId({ user: req.user });
    return this.billingService.getPlanDetailsForOrg(orgId);
  }
}
