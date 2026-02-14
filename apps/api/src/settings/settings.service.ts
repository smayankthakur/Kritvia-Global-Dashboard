import { Injectable } from "@nestjs/common";
import { ActivityEntityType } from "@prisma/client";
import { ActivityLogService } from "../activity-log/activity-log.service";
import { AuthUserContext } from "../auth/auth.types";
import { PolicyResolverService } from "../policy/policy-resolver.service";
import { PrismaService } from "../prisma/prisma.service";
import { UpdatePolicyDto } from "./dto/update-policy.dto";

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLogService: ActivityLogService,
    private readonly policyResolverService: PolicyResolverService
  ) {}

  async getPolicies(authUser: AuthUserContext) {
    return this.policyResolverService.getPolicyForOrg(authUser.orgId);
  }

  async updatePolicies(authUser: AuthUserContext, dto: UpdatePolicyDto) {
    const current = await this.policyResolverService.getPolicyForOrg(authUser.orgId);
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
        autopilotAutoStaleDeals: dto.autopilotAutoStaleDeals
      }
    });

    await this.activityLogService.log({
      orgId: authUser.orgId,
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
