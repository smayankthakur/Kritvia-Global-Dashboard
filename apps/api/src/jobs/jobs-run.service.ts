import { Injectable } from "@nestjs/common";
import {
  ActivityEntityType,
  DealStage,
  InvoiceStatus,
  NudgeStatus,
  NudgeType,
  Prisma,
  WorkItemStatus
} from "@prisma/client";
import { ActivityLogService } from "../activity-log/activity-log.service";
import { PolicyResolverService } from "../policy/policy-resolver.service";
import { PrismaService } from "../prisma/prisma.service";
import { computeNudgeScore } from "../nudges/nudge-scoring.util";

interface OrgRunSummary {
  orgId: string;
  invoicesLocked: number;
  dealsStaled: number;
  nudgesCreated: number;
  durationMs: number;
}

export interface JobsRunSummary {
  processedOrgs: number;
  invoicesLocked: number;
  dealsStaled: number;
  nudgesCreated: number;
  durationMs: number;
  perOrg: OrgRunSummary[];
}

@Injectable()
export class JobsRunService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policyResolverService: PolicyResolverService,
    private readonly activityLogService: ActivityLogService
  ) {}

  async run(now: Date = new Date()): Promise<JobsRunSummary> {
    const startedAt = Date.now();
    const orgs = await this.prisma.org.findMany({
      select: { id: true }
    });

    let processedOrgs = 0;
    let invoicesLocked = 0;
    let dealsStaled = 0;
    let nudgesCreated = 0;
    const perOrg: OrgRunSummary[] = [];

    for (const org of orgs) {
      const policy = await this.policyResolverService.getPolicyForOrg(org.id);
      if (!policy.autopilotEnabled) {
        continue;
      }

      processedOrgs += 1;
      const result = await this.runForOrg(org.id, now);
      invoicesLocked += result.invoicesLocked;
      dealsStaled += result.dealsStaled;
      nudgesCreated += result.nudgesCreated;
      perOrg.push(result);
    }

    return {
      processedOrgs,
      invoicesLocked,
      dealsStaled,
      nudgesCreated,
      durationMs: Date.now() - startedAt,
      perOrg
    };
  }

  async runForOrg(orgId: string, now: Date): Promise<OrgRunSummary> {
    const startedAt = Date.now();
    const policy = await this.policyResolverService.getPolicyForOrg(orgId);
    const invoicesLocked = await this.runAutoLockInvoices(orgId, now);
    const dealsStaled = await this.runAutoStaleDeals(orgId, now, policy.staleDealAfterDays);
    const nudgesCreated = policy.autopilotNudgeOnOverdue
      ? await this.runAutoOverdueNudges(orgId, now)
      : 0;

    return {
      orgId,
      invoicesLocked,
      dealsStaled,
      nudgesCreated,
      durationMs: Date.now() - startedAt
    };
  }

  private async runAutoLockInvoices(orgId: string, now: Date): Promise<number> {
    const candidates = await this.prisma.invoice.findMany({
      where: {
        orgId,
        status: InvoiceStatus.SENT,
        lockAt: { lte: now },
        lockedAt: null
      },
      orderBy: { lockAt: "asc" },
      take: 500
    });

    let invoicesLocked = 0;
    for (const invoice of candidates) {
      const update = await this.prisma.invoice.updateMany({
        where: {
          id: invoice.id,
          lockedAt: null
        },
        data: {
          lockedAt: now
        }
      });
      if (update.count === 0) {
        continue;
      }

      invoicesLocked += 1;
      await this.activityLogService.log({
        orgId,
        entityType: ActivityEntityType.INVOICE,
        entityId: invoice.id,
        action: "INVOICE_AUTO_LOCK",
        before: invoice,
        after: { lockedAt: now }
      });
    }

    return invoicesLocked;
  }

  private async runAutoStaleDeals(
    orgId: string,
    now: Date,
    staleDealAfterDays: number
  ): Promise<number> {
    const threshold = new Date(now);
    threshold.setUTCDate(threshold.getUTCDate() - staleDealAfterDays);

    const candidates = await this.prisma.deal.findMany({
      where: {
        orgId,
        stage: DealStage.OPEN,
        isStale: false,
        updatedAt: { lt: threshold }
      },
      orderBy: { updatedAt: "asc" },
      take: 500
    });

    let dealsStaled = 0;
    for (const deal of candidates) {
      const update = await this.prisma.deal.updateMany({
        where: {
          id: deal.id,
          isStale: false
        },
        data: {
          isStale: true
        }
      });
      if (update.count === 0) {
        continue;
      }

      dealsStaled += 1;
      await this.activityLogService.log({
        orgId,
        entityType: ActivityEntityType.DEAL,
        entityId: deal.id,
        action: "DEAL_AUTO_STALE",
        before: deal,
        after: { isStale: true }
      });
    }

    return dealsStaled;
  }

  private async runAutoOverdueNudges(orgId: string, now: Date): Promise<number> {
    const systemUser = await this.prisma.user.findFirst({
      where: { orgId, isActive: true },
      orderBy: [{ role: "desc" }, { createdAt: "asc" }],
      select: { id: true }
    });
    if (!systemUser) {
      return 0;
    }

    const [overdueWorkItems, overdueInvoices] = await this.prisma.$transaction([
      this.prisma.workItem.findMany({
        where: {
          orgId,
          status: { not: WorkItemStatus.DONE },
          dueDate: { lt: now }
        },
        take: 500,
        select: {
          id: true,
          dueDate: true,
          assignedToUserId: true,
          createdByUserId: true,
          deal: {
            select: {
              valueAmount: true
            }
          }
        }
      }),
      this.prisma.invoice.findMany({
        where: {
          orgId,
          status: { not: InvoiceStatus.PAID },
          dueDate: { lt: now }
        },
        take: 500,
        select: {
          id: true,
          dueDate: true,
          amount: true,
          createdByUserId: true
        }
      })
    ]);

    let nudgesCreated = 0;
    for (const item of overdueWorkItems) {
      const targetUserId = item.assignedToUserId ?? item.createdByUserId;
      const created = await this.createAutoNudgeIfMissing({
        orgId,
        creatorUserId: systemUser.id,
        targetUserId,
        type: NudgeType.OVERDUE_WORK,
        entityType: ActivityEntityType.WORK_ITEM,
        entityId: item.id,
        message: "Auto nudge: overdue work item requires action",
        scoreInput: {
          type: NudgeType.OVERDUE_WORK,
          now,
          dueDate: item.dueDate,
          dealValue: item.deal?.valueAmount ?? 0
        }
      });
      nudgesCreated += created ? 1 : 0;
    }

    for (const invoice of overdueInvoices) {
      const created = await this.createAutoNudgeIfMissing({
        orgId,
        creatorUserId: systemUser.id,
        targetUserId: invoice.createdByUserId,
        type: NudgeType.OVERDUE_INVOICE,
        entityType: ActivityEntityType.INVOICE,
        entityId: invoice.id,
        message: "Auto nudge: overdue invoice requires follow-up",
        scoreInput: {
          type: NudgeType.OVERDUE_INVOICE,
          now,
          dueDate: invoice.dueDate,
          amount: Number(invoice.amount)
        }
      });
      nudgesCreated += created ? 1 : 0;
    }

    return nudgesCreated;
  }

  private async createAutoNudgeIfMissing(input: {
    orgId: string;
    creatorUserId: string;
    targetUserId: string;
    type: NudgeType;
    entityType: ActivityEntityType;
    entityId: string;
    message: string;
    scoreInput: {
      type: NudgeType;
      now: Date;
      dueDate?: Date | null;
      amount?: number | null;
      dealValue?: number | null;
      updatedAt?: Date | null;
    };
  }): Promise<boolean> {
    const existing = await this.prisma.nudge.findFirst({
      where: {
        orgId: input.orgId,
        type: input.type,
        entityType: input.entityType,
        entityId: input.entityId,
        status: NudgeStatus.OPEN
      },
      select: { id: true }
    });
    if (existing) {
      return false;
    }

    const scoreResult = computeNudgeScore(input.scoreInput);

    const nudge = await this.prisma.nudge.create({
      data: {
        orgId: input.orgId,
        createdByUserId: input.creatorUserId,
        targetUserId: input.targetUserId,
        type: input.type,
        entityType: input.entityType,
        entityId: input.entityId,
        message: input.message,
        status: NudgeStatus.OPEN,
        severity: scoreResult.severity,
        priorityScore: scoreResult.priorityScore,
        meta: scoreResult.meta as Prisma.InputJsonValue
      }
    });

    await this.activityLogService.log({
      orgId: input.orgId,
      actorUserId: input.creatorUserId,
      entityType: input.entityType,
      entityId: input.entityId,
      action: "NUDGE_AUTO_CREATE",
      after: nudge
    });
    return true;
  }
}
