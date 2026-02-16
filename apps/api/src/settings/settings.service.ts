import { Injectable } from "@nestjs/common";
import { ActivityEntityType } from "@prisma/client";
import { ActivityLogService } from "../activity-log/activity-log.service";
import { AuthUserContext } from "../auth/auth.types";
import { BillingService } from "../billing/billing.service";
import { getActiveOrgId } from "../common/auth-org";
import { isValidIpAllowlistEntry } from "../common/ip-allowlist.util";
import { PolicyResolverService } from "../policy/policy-resolver.service";
import { PrismaService } from "../prisma/prisma.service";
import { UpdatePolicyDto } from "./dto/update-policy.dto";
import { BadRequestException } from "@nestjs/common";

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLogService: ActivityLogService,
    private readonly policyResolverService: PolicyResolverService,
    private readonly billingService: BillingService
  ) {}

  async getPolicies(authUser: AuthUserContext) {
    const activeOrgId = getActiveOrgId({ user: authUser });
    return this.policyResolverService.getPolicyForOrg(activeOrgId);
  }

  async updatePolicies(authUser: AuthUserContext, dto: UpdatePolicyDto) {
    const activeOrgId = getActiveOrgId({ user: authUser });
    const current = await this.policyResolverService.getPolicyForOrg(activeOrgId);
    if (dto.autopilotEnabled && !current.autopilotEnabled) {
      await this.billingService.assertFeature(activeOrgId, "autopilotEnabled");
    }

    const ipAllowlist = dto.ipAllowlist ?? (Array.isArray(current.ipAllowlist) ? current.ipAllowlist : []);
    if (!Array.isArray(ipAllowlist)) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Invalid request.",
        details: [{ field: "ipAllowlist", issues: ["ipAllowlist must be an array of IP/CIDR values."] }]
      });
    }
    const invalidEntries = ipAllowlist.filter((entry) => !isValidIpAllowlistEntry(String(entry)));
    if (invalidEntries.length > 0) {
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: "Invalid request.",
        details: [
          {
            field: "ipAllowlist",
            issues: [`Invalid IP/CIDR entries: ${invalidEntries.join(", ")}`]
          }
        ]
      });
    }

    const updated = await this.prisma.policy.update({
      where: { id: current.id },
      data: {
        lockInvoiceOnSent: dto.lockInvoiceOnSent,
        overdueAfterDays: dto.overdueAfterDays,
        defaultWorkDueDays: dto.defaultWorkDueDays,
        staleDealAfterDays: dto.staleDealAfterDays,
        leadStaleAfterHours: dto.leadStaleAfterHours,
        requireDealOwner: dto.requireDealOwner,
        requireWorkOwner: dto.requireWorkOwner,
        requireWorkDueDate: dto.requireWorkDueDate,
        autoLockInvoiceAfterDays: dto.autoLockInvoiceAfterDays,
        preventInvoiceUnlockAfterPartialPayment: dto.preventInvoiceUnlockAfterPartialPayment,
        autopilotEnabled: dto.autopilotEnabled,
        autopilotCreateWorkOnDealStageChange: dto.autopilotCreateWorkOnDealStageChange,
        autopilotNudgeOnOverdue: dto.autopilotNudgeOnOverdue,
        autopilotAutoStaleDeals: dto.autopilotAutoStaleDeals,
        auditRetentionDays: dto.auditRetentionDays,
        securityEventRetentionDays: dto.securityEventRetentionDays,
        ipRestrictionEnabled: dto.ipRestrictionEnabled,
        ipAllowlist
      }
    });

    await this.activityLogService.log({
      orgId: activeOrgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.POLICY,
      entityId: updated.id,
      action: "POLICY_UPDATE",
      before: current,
      after: updated
    });

    return updated;
  }
}
