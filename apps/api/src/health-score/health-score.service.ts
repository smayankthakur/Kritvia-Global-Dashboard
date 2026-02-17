import { BadRequestException, Injectable } from "@nestjs/common";
import { DealStage, InvoiceStatus, Prisma, WorkItemStatus } from "@prisma/client";
import { AuthUserContext } from "../auth/auth.types";
import { TtlCache } from "../common/cache/ttl-cache.util";
import { PrismaService } from "../prisma/prisma.service";
import { HealthScoreExplainResponseDto } from "./dto/health-score-explain-response.dto";
import { HealthScoreResponseDto } from "./dto/health-score-response.dto";
import { explainHealthScoreDelta } from "./health-score-explain.util";
import { computeHealthScore } from "./health-score.util";

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function dateKeyOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDateKey(dateKey: string): Date {
  const parsed = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || dateKeyOf(parsed) !== dateKey) {
    throw new BadRequestException("Invalid date. Use YYYY-MM-DD.");
  }
  return parsed;
}

@Injectable()
export class HealthScoreService {
  private readonly staleDays = 7;
  private static readonly cache = new TtlCache();
  private static readonly CACHE_TTL_MS = 60_000;

  constructor(private readonly prisma: PrismaService) {}

  async getOrComputeForUser(authUser: AuthUserContext): Promise<HealthScoreResponseDto> {
    const orgId = authUser.activeOrgId ?? authUser.orgId;
    const cacheKey = `health-score:${orgId}`;
    const cached = HealthScoreService.cache.get<HealthScoreResponseDto>(cacheKey);
    if (cached) {
      return cached;
    }

    const now = new Date();
    const targetDateKey = dateKeyOf(now);
    const snapshot = await this.getOrComputeSnapshotForDate(orgId, targetDateKey);
    const yesterdaySnapshot = await this.getOrComputeSnapshotForDate(
      orgId,
      dateKeyOf(this.previousDayOf(parseDateKey(targetDateKey)))
    );
    const breakdown = snapshot.breakdown as unknown as HealthScoreResponseDto["breakdown"];
    const yesterdayScore = yesterdaySnapshot.score;

    const response = {
      score: snapshot.score,
      breakdown,
      computedAt: snapshot.computedAt.toISOString(),
      dateKey: snapshot.dateKey,
      trend: {
        yesterdayScore,
        delta: snapshot.score - yesterdayScore
      }
    };

    HealthScoreService.cache.set(cacheKey, response, HealthScoreService.CACHE_TTL_MS);
    return response;
  }

  async computeForUser(authUser: AuthUserContext): Promise<HealthScoreResponseDto> {
    const orgId = authUser.activeOrgId ?? authUser.orgId;
    return this.computeForOrg(orgId);
  }

  async computeForOrg(orgId: string): Promise<HealthScoreResponseDto> {
    const snapshot = await this.computeAndUpsert(orgId, new Date());
    const breakdown = snapshot.breakdown as unknown as HealthScoreResponseDto["breakdown"];
    HealthScoreService.cache.delete(`health-score:${orgId}`);
    return {
      score: snapshot.score,
      breakdown,
      computedAt: snapshot.computedAt.toISOString(),
      dateKey: snapshot.dateKey,
      trend: {}
    };
  }

  async explainForUser(
    authUser: AuthUserContext,
    inputDateKey?: string
  ): Promise<HealthScoreExplainResponseDto> {
    const targetDateKey = inputDateKey ?? dateKeyOf(new Date());
    const targetDate = parseDateKey(targetDateKey);
    const previousDateKey = dateKeyOf(this.previousDayOf(targetDate));

    const [targetSnapshot, previousSnapshot] = await Promise.all([
      this.getOrComputeSnapshotForDate(authUser.orgId, targetDateKey),
      this.getOrComputeSnapshotForDate(authUser.orgId, previousDateKey)
    ]);

    const targetBreakdown = targetSnapshot.breakdown as unknown as HealthScoreResponseDto["breakdown"];
    const previousBreakdown =
      previousSnapshot.breakdown as unknown as HealthScoreResponseDto["breakdown"];
    const drivers = explainHealthScoreDelta(previousBreakdown, targetBreakdown);

    return {
      dateKey: targetDateKey,
      todayScore: targetSnapshot.score,
      yesterdayScore: previousSnapshot.score,
      delta: targetSnapshot.score - previousSnapshot.score,
      drivers,
      notes: ["Drivers show only negative contributors (penalty increases)."],
      breakdown: {
        today: targetBreakdown,
        yesterday: previousBreakdown
      }
    };
  }

  private previousDayOf(date: Date): Date {
    const day = new Date(startOfUtcDay(date));
    day.setUTCDate(day.getUTCDate() - 1);
    return day;
  }

  private async getOrComputeSnapshotForDate(orgId: string, dateKey: string) {
    const existing = await this.prisma.orgHealthSnapshot.findUnique({
      where: {
        orgId_dateKey: {
          orgId,
          dateKey
        }
      }
    });
    if (existing) {
      return existing;
    }
    return this.computeAndUpsert(orgId, parseDateKey(dateKey));
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
