import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

const POLICY_DEFAULTS = {
  lockInvoiceOnSent: true,
  overdueAfterDays: 0,
  defaultWorkDueDays: 3,
  staleDealAfterDays: 7,
  leadStaleAfterHours: 72,
  requireDealOwner: true,
  requireWorkOwner: true,
  requireWorkDueDate: true,
  autoLockInvoiceAfterDays: 2,
  preventInvoiceUnlockAfterPartialPayment: true,
  autopilotEnabled: false,
  autopilotCreateWorkOnDealStageChange: true,
  autopilotNudgeOnOverdue: true,
  autopilotAutoStaleDeals: true
} as const;

@Injectable()
export class PolicyResolverService {
  constructor(private readonly prisma: PrismaService) {}

  async getPolicyForOrg(orgId: string) {
    return this.prisma.policy.upsert({
      where: { orgId },
      update: {},
      create: {
        orgId,
        ...POLICY_DEFAULTS
      }
    });
  }
}
