import { Injectable } from "@nestjs/common";
import { DealStage, InvoiceStatus, Prisma, WorkItemStatus } from "@prisma/client";
import { AuthUserContext } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { HealthScoreResponseDto } from "./dto/health-score-response.dto";
import { computeHealthScore } from "./health-score.util";

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function dateKeyOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

@Injectable()
export class HealthScoreService {
  private readonly staleDays = 7;

  constructor(private readonly prisma: PrismaService) {}

  async getOrComputeForUser(authUser: AuthUserContext): Promise<HealthScoreResponseDto> {
    const now = new Date();
    const todayDateKey = dateKeyOf(now);
    let snapshot = await this.prisma.orgHealthSnapshot.findUnique({
      where: {
        orgId_dateKey: {
          orgId: authUser.orgId,
          dateKey: todayDateKey
        }
      }
    });

    if (!snapshot) {
      snapshot = await this.computeAndUpsert(authUser.orgId, now);
    }

    const yesterday = new Date(startOfUtcDay(now));
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yesterdaySnapshot = await this.prisma.orgHealthSnapshot.findUnique({
      where: {
        orgId_dateKey: {
          orgId: authUser.orgId,
          dateKey: dateKeyOf(yesterday)
        }
      }
    });

    const breakdown = snapshot.breakdown as unknown as HealthScoreResponseDto["breakdown"];
    const yesterdayScore = yesterdaySnapshot?.score;

    return {
      score: snapshot.score,
      breakdown,
      computedAt: snapshot.computedAt.toISOString(),
      dateKey: snapshot.dateKey,
      trend: {
        ...(yesterdayScore !== undefined ? { yesterdayScore } : {}),
        ...(yesterdayScore !== undefined ? { delta: snapshot.score - yesterdayScore } : {})
      }
    };
  }

  async computeForUser(authUser: AuthUserContext): Promise<HealthScoreResponseDto> {
    const snapshot = await this.computeAndUpsert(authUser.orgId, new Date());
    const breakdown = snapshot.breakdown as unknown as HealthScoreResponseDto["breakdown"];
    return {
      score: snapshot.score,
      breakdown,
      computedAt: snapshot.computedAt.toISOString(),
      dateKey: snapshot.dateKey,
      trend: {}
    };
  }

  private async computeAndUpsert(orgId: string, now: Date) {
    const today = startOfUtcDay(now);
    const dateKey = dateKeyOf(now);
    const staleCutoff = new Date(now);
    staleCutoff.setUTCDate(staleCutoff.getUTCDate() - this.staleDays);

    const [
      totalOpenWorkItems,
      overdueWorkItems,
      totalUnpaidInvoices,
      overdueInvoices,
      totalOpenDeals,
      staleOpenDeals,
      unassignedDeals,
      workWithoutDueDate,
      sentUnlockedInvoices
    ] = await this.prisma.$transaction([
      this.prisma.workItem.count({
        where: { orgId, status: { not: WorkItemStatus.DONE } }
      }),
      this.prisma.workItem.count({
        where: { orgId, status: { not: WorkItemStatus.DONE }, dueDate: { lt: today } }
      }),
      this.prisma.invoice.count({
        where: { orgId, status: { not: InvoiceStatus.PAID } }
      }),
      this.prisma.invoice.count({
        where: { orgId, status: { not: InvoiceStatus.PAID }, dueDate: { lt: today } }
      }),
      this.prisma.deal.count({
        where: { orgId, stage: DealStage.OPEN }
      }),
      this.prisma.deal.count({
        where: { orgId, stage: DealStage.OPEN, createdAt: { lt: staleCutoff } }
      }),
      this.prisma.deal.count({
        where: { orgId, stage: DealStage.OPEN, ownerUserId: null }
      }),
      this.prisma.workItem.count({
        where: { orgId, status: { not: WorkItemStatus.DONE }, dueDate: null }
      }),
      this.prisma.invoice.count({
        where: { orgId, status: InvoiceStatus.SENT, lockedAt: null }
      })
    ]);

    const overdueWorkPct = totalOpenWorkItems === 0 ? 0 : overdueWorkItems / totalOpenWorkItems;
    const overdueInvoicePct = totalUnpaidInvoices === 0 ? 0 : overdueInvoices / totalUnpaidInvoices;
    const staleDealsPct = totalOpenDeals === 0 ? 0 : staleOpenDeals / totalOpenDeals;
    const hygieneCount = unassignedDeals + workWithoutDueDate + sentUnlockedInvoices;

    const computed = computeHealthScore({
      overdueWorkPct,
      overdueInvoicePct,
      staleDealsPct,
      hygieneCount,
      staleDays: this.staleDays
    });

    return this.prisma.orgHealthSnapshot.upsert({
      where: {
        orgId_dateKey: {
          orgId,
          dateKey
        }
      },
      create: {
        orgId,
        dateKey,
        score: computed.score,
        breakdown: computed.breakdown as unknown as Prisma.InputJsonValue,
        computedAt: now
      },
      update: {
        score: computed.score,
        breakdown: computed.breakdown as unknown as Prisma.InputJsonValue,
        computedAt: now
      }
    });
  }
}
