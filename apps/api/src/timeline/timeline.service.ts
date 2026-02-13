import { Injectable, NotFoundException } from "@nestjs/common";
import { ActivityEntityType } from "@prisma/client";
import { AuthUserContext } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import {
  DealTimelineMilestoneDto,
  DealTimelineMilestoneType,
  DealTimelineResponseDto
} from "./dto/deal-timeline-response.dto";

interface MilestoneSeed {
  type: DealTimelineMilestoneType;
  timestamp: Date;
}

@Injectable()
export class TimelineService {
  constructor(private readonly prisma: PrismaService) {}

  async getDealTimeline(dealId: string, authUser: AuthUserContext): Promise<DealTimelineResponseDto> {
    const deal = await this.prisma.deal.findFirst({
      where: {
        id: dealId,
        orgId: authUser.orgId
      },
      select: {
        id: true,
        orgId: true,
        companyId: true,
        createdAt: true
      }
    });

    if (!deal) {
      throw new NotFoundException("Deal not found");
    }

    const [policy, lead, rootWorkItem, invoices] = await this.prisma.$transaction([
      this.prisma.policy.findUnique({
        where: { orgId: authUser.orgId },
        select: { overdueAfterDays: true }
      }),
      this.prisma.lead.findFirst({
        where: {
          orgId: authUser.orgId,
          companyId: deal.companyId
        },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true }
      }),
      this.prisma.workItem.findFirst({
        where: {
          orgId: authUser.orgId,
          dealId: deal.id
        },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true }
      }),
      this.prisma.invoice.findMany({
        where: {
          orgId: authUser.orgId,
          dealId: deal.id
        },
        select: { id: true }
      })
    ]);

    const invoiceIds = invoices.map((invoice) => invoice.id);
    let firstSentLog: { createdAt: Date } | null = null;
    let firstPaidLog: { createdAt: Date } | null = null;

    if (invoiceIds.length > 0) {
      [firstSentLog, firstPaidLog] = await this.prisma.$transaction([
        this.prisma.activityLog.findFirst({
          where: {
            orgId: authUser.orgId,
            entityType: ActivityEntityType.INVOICE,
            entityId: { in: invoiceIds },
            action: "SEND"
          },
          orderBy: { createdAt: "asc" },
          select: { createdAt: true }
        }),
        this.prisma.activityLog.findFirst({
          where: {
            orgId: authUser.orgId,
            entityType: ActivityEntityType.INVOICE,
            entityId: { in: invoiceIds },
            action: "MARK_PAID"
          },
          orderBy: { createdAt: "asc" },
          select: { createdAt: true }
        })
      ]);
    }

    const seeds: MilestoneSeed[] = [];
    if (lead?.createdAt) {
      seeds.push({ type: "LEAD_CREATED", timestamp: lead.createdAt });
    }
    seeds.push({ type: "DEAL_CREATED", timestamp: deal.createdAt });
    if (rootWorkItem?.createdAt) {
      seeds.push({ type: "WORK_ROOT_CREATED", timestamp: rootWorkItem.createdAt });
    }
    if (firstSentLog?.createdAt) {
      seeds.push({ type: "INVOICE_SENT", timestamp: firstSentLog.createdAt });
    }
    if (firstPaidLog?.createdAt) {
      seeds.push({ type: "INVOICE_PAID", timestamp: firstPaidLog.createdAt });
    }

    const policyThresholdHours = Math.max(0, (policy?.overdueAfterDays ?? 0) * 24);
    const milestones = this.buildTimelineMilestones(seeds, policyThresholdHours);
    const totalCycleHours =
      milestones.length >= 2
        ? this.toHours(
            new Date(milestones[milestones.length - 1].timestamp).getTime() -
              new Date(milestones[0].timestamp).getTime()
          )
        : null;

    return {
      dealId: deal.id,
      policyThresholdHours,
      totalCycleHours,
      milestones
    };
  }

  buildTimelineMilestones(
    seeds: MilestoneSeed[],
    policyThresholdHours: number
  ): DealTimelineMilestoneDto[] {
    const milestones: DealTimelineMilestoneDto[] = [];

    for (const seed of seeds) {
      const previous = milestones[milestones.length - 1];
      const timestampIso = seed.timestamp.toISOString();

      if (!previous) {
        milestones.push({
          type: seed.type,
          timestamp: timestampIso,
          durationFromPreviousHours: null,
          isBottleneck: false
        });
        continue;
      }

      const durationFromPreviousHours = this.toHours(
        seed.timestamp.getTime() - new Date(previous.timestamp).getTime()
      );

      milestones.push({
        type: seed.type,
        timestamp: timestampIso,
        durationFromPreviousHours,
        isBottleneck: durationFromPreviousHours > policyThresholdHours
      });
    }

    return milestones;
  }

  private toHours(milliseconds: number): number {
    const hours = milliseconds / (1000 * 60 * 60);
    return Math.round(hours * 100) / 100;
  }
}

