import { Injectable, NotFoundException } from "@nestjs/common";
import {
  ActivityEntityType,
  DealStage,
  InvoiceStatus,
  Prisma,
  WorkItemStatus
} from "@prisma/client";
import { ActivityLogService } from "../activity-log/activity-log.service";
import { TtlCache } from "../common/cache/ttl-cache.util";
import { WEBHOOK_EVENTS } from "../org-webhooks/webhook-events";
import { WebhookService } from "../org-webhooks/webhook.service";
import { PrismaService } from "../prisma/prisma.service";
import { InsightListItem, InsightSummaryResponse } from "./ai.types";

type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
type InsightType = "DEAL_STALL" | "CASHFLOW_ALERT" | "OPS_RISK" | "SHIELD_RISK" | "HEALTH_DROP";

interface InsightCandidate {
  type: InsightType;
  severity: Severity;
  scoreImpact: number;
  title: string;
  explanation: string;
  entityType?: string;
  entityId?: string;
  meta: Prisma.InputJsonValue;
}

interface InsightMetrics {
  now: Date;
  stalledDeals: {
    count: number;
    topDeals: Array<{ id: string; name: string; daysIdle: number; value: number }>;
  };
  cashflow: {
    count: number;
    amount: number;
    topInvoices: Array<{ id: string; invoiceNumber: string | null; daysOverdue: number; amount: number }>;
  };
  ops: {
    count: number;
    byAssignee: Array<{ userId: string; count: number }>;
  };
  shield: {
    count: number;
    recent: Array<{ id: string; type: string; createdAt: string }>;
  };
  healthDrop: {
    hasData: boolean;
    previousScore: number;
    latestScore: number;
    delta: number;
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SEVERITY_ORDER: Record<Severity, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1
};

@Injectable()
export class AiService {
  private static readonly cache = new TtlCache();
  private static readonly CACHE_TTL_MS = 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLogService: ActivityLogService,
    private readonly webhookService: WebhookService
  ) {}

  async computeInsights(orgId: string): Promise<InsightSummaryResponse> {
    AiService.cache.delete(`insights:${orgId}`);
    const metrics = await this.collectMetrics(orgId);
    const candidates = this.buildCandidates(metrics);
    const createdInsights: Array<{
      id: string;
      orgId: string;
      type: string;
      severity: string;
      scoreImpact: number;
      title: string;
      explanation: string;
      entityType: string | null;
      entityId: string | null;
      meta: Prisma.JsonValue;
      createdAt: Date;
    }> = [];

    await this.prisma.$transaction(async (tx) => {
      for (const candidate of candidates) {
        const createdInsight = await this.upsertCandidate(tx, orgId, candidate);
        if (createdInsight) {
          createdInsights.push(createdInsight);
        }
      }

      const activeTypes = new Set(candidates.map((candidate) => candidate.type));
      const allTypes: InsightType[] = [
        "DEAL_STALL",
        "CASHFLOW_ALERT",
        "OPS_RISK",
        "SHIELD_RISK",
        "HEALTH_DROP"
      ];
      for (const type of allTypes) {
        if (activeTypes.has(type)) {
          continue;
        }
        await tx.aIInsight.updateMany({
          where: {
            orgId,
            type,
            isResolved: false
          },
          data: {
            isResolved: true,
            resolvedAt: metrics.now,
            meta: {
              note: "Auto-resolved by deterministic compute run."
            } as Prisma.InputJsonValue
          }
        });
      }
    });

    for (const insight of createdInsights) {
      void this.webhookService.dispatch(orgId, WEBHOOK_EVENTS.AI_INSIGHT_CREATED, {
        orgId: insight.orgId,
        insightId: insight.id,
        type: insight.type,
        severity: insight.severity,
        scoreImpact: insight.scoreImpact,
        title: insight.title,
        explanation: insight.explanation,
        entityType: insight.entityType,
        entityId: insight.entityId,
        meta: insight.meta,
        createdAt: insight.createdAt.toISOString()
      });
    }

    return this.summarize(orgId);
  }

  async listUnresolved(orgId: string): Promise<InsightListItem[]> {
    const cacheKey = `insights:${orgId}`;
    const cached = AiService.cache.get<InsightListItem[]>(cacheKey);
    if (cached) {
      return cached;
    }

    const insights = await this.prisma.aIInsight.findMany({
      where: {
        orgId,
        isResolved: false
      }
    });

    const response = insights
      .sort((left, right) => {
        const severityDelta =
          this.severityRank(right.severity) - this.severityRank(left.severity);
        if (severityDelta !== 0) {
          return severityDelta;
        }
        const impactDelta = right.scoreImpact - left.scoreImpact;
        if (impactDelta !== 0) {
          return impactDelta;
        }
        return right.createdAt.getTime() - left.createdAt.getTime();
      })
      .map((insight) => ({
        id: insight.id,
        type: insight.type,
        severity: insight.severity,
        scoreImpact: insight.scoreImpact,
        title: insight.title,
        explanation: insight.explanation,
        entityType: insight.entityType,
        entityId: insight.entityId,
        meta: insight.meta,
        isResolved: insight.isResolved,
        createdAt: insight.createdAt.toISOString(),
        resolvedAt: insight.resolvedAt ? insight.resolvedAt.toISOString() : null
      }));

    AiService.cache.set(cacheKey, response, AiService.CACHE_TTL_MS);
    return response;
  }

  async resolveInsight(orgId: string, insightId: string, actorUserId: string): Promise<{ success: true }> {
    const insight = await this.prisma.aIInsight.findFirst({
      where: {
        id: insightId,
        orgId
      }
    });
    if (!insight) {
      throw new NotFoundException("Insight not found");
    }
    if (!insight.isResolved) {
      await this.prisma.aIInsight.update({
        where: { id: insight.id },
        data: {
          isResolved: true,
          resolvedAt: new Date()
        }
      });
      await this.activityLogService.log({
        orgId,
        actorUserId,
        entityType: ActivityEntityType.AI_INSIGHT,
        entityId: insight.id,
        action: "AI_INSIGHT_RESOLVED",
        after: {
          type: insight.type,
          severity: insight.severity
        }
      });
    }
    AiService.cache.delete(`insights:${orgId}`);
    return { success: true };
  }

  private async summarize(orgId: string): Promise<InsightSummaryResponse> {
    const unresolved = await this.prisma.aIInsight.findMany({
      where: {
        orgId,
        isResolved: false
      },
      select: {
        severity: true
      }
    });

    const summary: InsightSummaryResponse = {
      total: unresolved.length,
      critical: 0,
      high: 0,
      medium: 0,
      low: 0
    };
    for (const row of unresolved) {
      const key = row.severity.toLowerCase() as "critical" | "high" | "medium" | "low";
      if (summary[key] !== undefined) {
        summary[key] += 1;
      }
    }
    return summary;
  }

  private async collectMetrics(orgId: string): Promise<InsightMetrics> {
    const now = new Date();
    const dealStallCutoff = new Date(now.getTime() - 14 * DAY_MS);
    const overdueInvoiceCutoff = new Date(now.getTime() - 7 * DAY_MS);

    const [
      stalledDealCount,
      topStalledDeals,
      overdueInvoiceCount,
      overdueInvoices,
      overdueWorkCount,
      overdueWorkByAssignee,
      criticalShieldCount,
      recentCriticalEvents,
      latestHealthSnapshots
    ] = await this.prisma.$transaction([
      this.prisma.deal.count({
        where: {
          orgId,
          stage: DealStage.OPEN,
          updatedAt: { lt: dealStallCutoff }
        }
      }),
      this.prisma.deal.findMany({
        where: {
          orgId,
          stage: DealStage.OPEN,
          updatedAt: { lt: dealStallCutoff }
        },
        orderBy: { updatedAt: "asc" },
        take: 3,
        select: {
          id: true,
          title: true,
          updatedAt: true,
          valueAmount: true
        }
      }),
      this.prisma.invoice.count({
        where: {
          orgId,
          status: { not: InvoiceStatus.PAID },
          dueDate: { lt: overdueInvoiceCutoff }
        }
      }),
      this.prisma.invoice.findMany({
        where: {
          orgId,
          status: { not: InvoiceStatus.PAID },
          dueDate: { lt: overdueInvoiceCutoff }
        },
        orderBy: { dueDate: "asc" },
        take: 3,
        select: {
          id: true,
          invoiceNumber: true,
          dueDate: true,
          amount: true
        }
      }),
      this.prisma.workItem.count({
        where: {
          orgId,
          status: { not: WorkItemStatus.DONE },
          dueDate: { lt: now }
        }
      }),
      this.prisma.workItem.findMany({
        where: {
          orgId,
          status: { not: WorkItemStatus.DONE },
          dueDate: { lt: now },
          assignedToUserId: { not: null }
        },
        select: {
          assignedToUserId: true
        },
        take: 500
      }),
      this.prisma.securityEvent.count({
        where: {
          orgId,
          resolvedAt: null,
          severity: "CRITICAL"
        }
      }),
      this.prisma.securityEvent.findMany({
        where: {
          orgId,
          resolvedAt: null,
          severity: "CRITICAL"
        },
        orderBy: { createdAt: "desc" },
        take: 3,
        select: {
          id: true,
          type: true,
          createdAt: true
        }
      }),
      this.prisma.orgHealthSnapshot.findMany({
        where: { orgId },
        orderBy: { computedAt: "desc" },
        take: 2,
        select: {
          score: true
        }
      })
    ]);

    const overdueAmount = overdueInvoices.reduce(
      (sum, invoice) => sum + Number(invoice.amount),
      0
    );

    const healthDrop =
      latestHealthSnapshots.length >= 2
        ? {
            hasData: true,
            latestScore: latestHealthSnapshots[0].score,
            previousScore: latestHealthSnapshots[1].score,
            delta: latestHealthSnapshots[0].score - latestHealthSnapshots[1].score
          }
        : {
            hasData: false,
            latestScore: 0,
            previousScore: 0,
            delta: 0
          };

    return {
      now,
      stalledDeals: {
        count: stalledDealCount,
        topDeals: topStalledDeals.map((deal) => ({
          id: deal.id,
          name: deal.title,
          daysIdle: Math.max(1, Math.floor((now.getTime() - deal.updatedAt.getTime()) / DAY_MS)),
          value: deal.valueAmount
        }))
      },
      cashflow: {
        count: overdueInvoiceCount,
        amount: overdueAmount,
        topInvoices: overdueInvoices.map((invoice) => ({
          id: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          daysOverdue: Math.max(1, Math.floor((now.getTime() - invoice.dueDate.getTime()) / DAY_MS)),
          amount: Number(invoice.amount)
        }))
      },
      ops: {
        count: overdueWorkCount,
        byAssignee: this.aggregateByAssignee(overdueWorkByAssignee)
      },
      shield: {
        count: criticalShieldCount,
        recent: recentCriticalEvents.map((event) => ({
          id: event.id,
          type: event.type,
          createdAt: event.createdAt.toISOString()
        }))
      },
      healthDrop
    };
  }

  private buildCandidates(metrics: InsightMetrics): InsightCandidate[] {
    const candidates: InsightCandidate[] = [];

    if (metrics.stalledDeals.count > 0) {
      const stalledDeals = metrics.stalledDeals.count;
      candidates.push({
        type: "DEAL_STALL",
        severity: this.dealStallSeverity(stalledDeals),
        scoreImpact: Math.min(30, stalledDeals * 3) + 10,
        title: "Deals stalling in pipeline",
        explanation: `${stalledDeals} open deals have been idle for more than 14 days.`,
        entityType: "DEAL",
        entityId: metrics.stalledDeals.topDeals[0]?.id,
        meta: {
          stalledDeals,
          topDeals: metrics.stalledDeals.topDeals
        } as Prisma.InputJsonValue
      });
    }

    if (metrics.cashflow.count > 0) {
      const overdueInvoices = metrics.cashflow.count;
      const overdueAmount = Math.round(metrics.cashflow.amount);
      candidates.push({
        type: "CASHFLOW_ALERT",
        severity: this.cashflowSeverity(overdueInvoices, overdueAmount),
        scoreImpact:
          Math.min(40, overdueInvoices * 4) +
          Math.min(30, Math.round(Math.log10(overdueAmount + 1) * 10)),
        title: "Cashflow risk: overdue invoices",
        explanation: `${overdueInvoices} invoices are overdue by more than 7 days, blocking INR ${overdueAmount}.`,
        entityType: "INVOICE",
        entityId: metrics.cashflow.topInvoices[0]?.id,
        meta: {
          overdueInvoices,
          overdueAmount,
          topInvoices: metrics.cashflow.topInvoices
        } as Prisma.InputJsonValue
      });
    }

    if (metrics.ops.count > 0) {
      const overdueWork = metrics.ops.count;
      candidates.push({
        type: "OPS_RISK",
        severity: this.opsSeverity(overdueWork),
        scoreImpact: Math.min(35, overdueWork * 2) + 10,
        title: "Ops risk: overdue execution load",
        explanation: `${overdueWork} open work items are overdue and need immediate intervention.`,
        entityType: "WORK_ITEM",
        meta: {
          overdueWork,
          byAssignee: metrics.ops.byAssignee
        } as Prisma.InputJsonValue
      });
    }

    if (metrics.shield.count > 0) {
      const criticalEvents = metrics.shield.count;
      candidates.push({
        type: "SHIELD_RISK",
        severity: "CRITICAL",
        scoreImpact: 40 + Math.min(20, criticalEvents * 5),
        title: "Security risk: critical events",
        explanation: `${criticalEvents} unresolved critical shield events are active.`,
        entityType: "SECURITY_EVENT",
        entityId: metrics.shield.recent[0]?.id,
        meta: {
          criticalEvents,
          recent: metrics.shield.recent
        } as Prisma.InputJsonValue
      });
    }

    if (metrics.healthDrop.hasData && metrics.healthDrop.delta <= -10) {
      const delta = metrics.healthDrop.delta;
      candidates.push({
        type: "HEALTH_DROP",
        severity: this.healthDropSeverity(delta),
        scoreImpact: Math.min(30, Math.abs(delta)) + 10,
        title: "Execution score dropped",
        explanation: `Execution score dropped from ${metrics.healthDrop.previousScore} to ${metrics.healthDrop.latestScore} (${delta}).`,
        entityType: "ORG_HEALTH",
        meta: {
          previousScore: metrics.healthDrop.previousScore,
          latestScore: metrics.healthDrop.latestScore,
          delta
        } as Prisma.InputJsonValue
      });
    }

    return candidates;
  }

  private async upsertCandidate(
    tx: Prisma.TransactionClient,
    orgId: string,
    candidate: InsightCandidate
  ): Promise<{
    id: string;
    orgId: string;
    type: string;
    severity: string;
    scoreImpact: number;
    title: string;
    explanation: string;
    entityType: string | null;
    entityId: string | null;
    meta: Prisma.JsonValue;
    createdAt: Date;
  } | null> {
    const unresolved = await tx.aIInsight.findMany({
      where: {
        orgId,
        type: candidate.type,
        isResolved: false
      },
      orderBy: {
        createdAt: "desc"
      }
    });

    const primary = unresolved[0];
    if (!primary) {
      return tx.aIInsight.create({
        data: {
          orgId,
          type: candidate.type,
          severity: candidate.severity,
          scoreImpact: candidate.scoreImpact,
          title: candidate.title,
          explanation: candidate.explanation,
          entityType: candidate.entityType,
          entityId: candidate.entityId,
          meta: candidate.meta,
          isResolved: false,
          createdAt: new Date(),
          resolvedAt: null
        }
      });
    }

    await tx.aIInsight.update({
      where: { id: primary.id },
      data: {
        severity: candidate.severity,
        scoreImpact: candidate.scoreImpact,
        title: candidate.title,
        explanation: candidate.explanation,
        entityType: candidate.entityType,
        entityId: candidate.entityId,
        meta: candidate.meta,
        createdAt: new Date(),
        resolvedAt: null,
        isResolved: false
      }
    });

    if (unresolved.length > 1) {
      await tx.aIInsight.updateMany({
        where: {
          orgId,
          type: candidate.type,
          isResolved: false,
          id: {
            not: primary.id
          }
        },
        data: {
          isResolved: true,
          resolvedAt: new Date()
        }
      });
    }

    return null;
  }

  private severityRank(severity: string): number {
    return SEVERITY_ORDER[severity as Severity] ?? 0;
  }

  private dealStallSeverity(count: number): Severity {
    if (count >= 10) return "CRITICAL";
    if (count >= 5) return "HIGH";
    if (count >= 2) return "MEDIUM";
    return "LOW";
  }

  private cashflowSeverity(count: number, amount: number): Severity {
    if (amount >= 200000 || count >= 10) return "CRITICAL";
    if (amount >= 100000 || count >= 5) return "HIGH";
    if (count >= 2) return "MEDIUM";
    return "LOW";
  }

  private opsSeverity(count: number): Severity {
    if (count >= 30) return "CRITICAL";
    if (count >= 15) return "HIGH";
    if (count >= 5) return "MEDIUM";
    return "LOW";
  }

  private healthDropSeverity(delta: number): Severity {
    if (delta <= -25) return "CRITICAL";
    if (delta <= -15) return "HIGH";
    return "MEDIUM";
  }

  private aggregateByAssignee(
    rows: Array<{ assignedToUserId: string | null }>
  ): Array<{ userId: string; count: number }> {
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (!row.assignedToUserId) {
        continue;
      }
      counts.set(row.assignedToUserId, (counts.get(row.assignedToUserId) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([userId, count]) => ({ userId, count }))
      .sort((left, right) => right.count - left.count)
      .slice(0, 5);
  }
}
