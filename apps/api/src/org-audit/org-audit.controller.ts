import { Controller, Get, Query, Req, Res, UseGuards } from "@nestjs/common";
import { Response } from "express";
import { Role } from "@prisma/client";
import { AuthUserContext } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { RequireTokenScope } from "../auth/token-scope.decorator";
import { TokenScopeGuard } from "../auth/token-scope.guard";
import { BillingService } from "../billing/billing.service";
import { getActiveOrgId } from "../common/auth-org";
import { ExportOrgAuditQueryDto } from "./dto/export-org-audit-query.dto";
import { OrgAuditService } from "./org-audit.service";

@Controller("org/audit")
@UseGuards(JwtAuthGuard, RolesGuard, TokenScopeGuard)
@Roles(Role.CEO, Role.ADMIN)
export class OrgAuditController {
  constructor(
    private readonly orgAuditService: OrgAuditService,
    private readonly billingService: BillingService
  ) {}

  @Get("export")
  @RequireTokenScope("read:audit")
  async exportAudit(
    @Req() req: { user: AuthUserContext },
    @Query() query: ExportOrgAuditQueryDto,
    @Res() res: Response
  ): Promise<void> {
    const activeOrgId = getActiveOrgId({ user: req.user });
    await this.billingService.assertFeature(activeOrgId, "enterpriseControlsEnabled");
    this.orgAuditService.validateFormat(query.format);
    const range = this.orgAuditService.resolveDateRange(query.from, query.to);
    await this.orgAuditService.streamCsvForOrg(activeOrgId, range, res);
  }
}
