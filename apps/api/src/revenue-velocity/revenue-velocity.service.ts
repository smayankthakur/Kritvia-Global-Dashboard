import { Injectable } from "@nestjs/common";
import { ActivityEntityType, DealStage, InvoiceStatus } from "@prisma/client";
import { AuthUserContext } from "../auth/auth.types";
import { BillingService } from "../billing/billing.service";
import { getActiveOrgId } from "../common/auth-org";
import { PrismaService } from "../prisma/prisma.service";
import { CashflowForecastResponseDto } from "./dto/cashflow-forecast-response.dto";
import { RevenueVelocityResponseDto } from "./dto/revenue-velocity-response.dto";
import {
  averageCloseDays,
  averagePaymentDelayDays,
  bucketizeDealAge,
  computePipelineWeightedForecast,
  safePct
} from "./revenue-velocity.util";

@Injectable()
export class RevenueVelocityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billingService: BillingService
  ) {}

  async getRevenueVelocity(authUser: AuthUserContext): Promise<RevenueVelocityResponseDto> {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "revenueIntelligenceEnabled");
    const now = new Date();

    const [
      totalLeads,
      totalDeals,
      wonCount,
      lostCount,
      openCount,
      convertedLeadActivities,
      wonDeals,
      openDeals
    ] = await this.prisma.$transaction([
      this.prisma.lead.count({
        where: { orgId }
      }),
      this.prisma.deal.count({
        where: { orgId }
      }),
      this.prisma.deal.count({
        where: { orgId, stage: DealStage.WON }
      }),
      this.prisma.deal.count({
        where: { orgId, stage: DealStage.LOST }
      }),
      this.prisma.deal.count({
        where: { orgId, stage: DealStage.OPEN }
      }),
      this.prisma.activityLog.findMany({
        where: {
          orgId,
          entityType: ActivityEntityType.LEAD,
          action: "CONVERT"
        },
        select: {
          entityId: true
        },
        distinct: ["entityId"]
      }),
      this.prisma.deal.findMany({
        where: { orgId, stage: DealStage.WON, wonAt: { not: null } },
        select: {
          createdAt: true,
          wonAt: true
        }
      }),
      this.prisma.deal.findMany({
        where: { orgId, stage: DealStage.OPEN },
        select: {
          createdAt: true
        }
      })
    ]);

    const pipelineAging: RevenueVelocityResponseDto["pipelineAging"] = {
      "0_7": 0,
      "8_14": 0,
      "15_30": 0,
      "30_plus": 0
    };

    for (const deal of openDeals) {
      const bucket = bucketizeDealAge(deal.createdAt, now);
      pipelineAging[bucket] += 1;
    }

    const convertedLeadCount = convertedLeadActivities.length;

    return {
      avgCloseDays: averageCloseDays(wonDeals),
      stageConversion: {
        leadToDealPct: safePct(convertedLeadCount, totalLeads),
        dealToWonPct: safePct(wonCount, totalDeals)
      },
      pipelineAging,
      dropOffPct: safePct(lostCount, totalDeals),
      counts: {
        leads: totalLeads,
        deals: totalDeals,
        won: wonCount,
        lost: lostCount,
        open: openCount
      }
    };
  }

  async getCashflowForecast(authUser: AuthUserContext): Promise<CashflowForecastResponseDto> {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "revenueIntelligenceEnabled");
    const now = new Date();
    const day30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const day60 = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);

    const [
      outstandingReceivablesAgg,
      dueIn30Count,
      dueIn60Count,
      overdueCount,
      invoicesForecast30Agg,
      invoicesForecast60Agg,
      paidInvoices,
      openDeals
    ] = await this.prisma.$transaction([
      this.prisma.invoice.aggregate({
        where: {
          orgId,
          status: { not: InvoiceStatus.PAID }
        },
        _sum: { amount: true }
      }),
      this.prisma.invoice.count({
        where: {
          orgId,
          status: { not: InvoiceStatus.PAID },
          dueDate: { lte: day30 }
        }
      }),
      this.prisma.invoice.count({
        where: {
          orgId,
          status: { not: InvoiceStatus.PAID },
          dueDate: { lte: day60 }
        }
      }),
      this.prisma.invoice.count({
        where: {
          orgId,
          status: { not: InvoiceStatus.PAID },
          dueDate: { lt: now }
        }
      }),
      this.prisma.invoice.aggregate({
        where: {
          orgId,
          status: { not: InvoiceStatus.PAID },
          dueDate: { lte: day30 }
        },
        _sum: { amount: true }
      }),
      this.prisma.invoice.aggregate({
        where: {
          orgId,
          status: { not: InvoiceStatus.PAID },
          dueDate: { lte: day60 }
        },
        _sum: { amount: true }
      }),
      this.prisma.invoice.findMany({
        where: {
          orgId,
          status: InvoiceStatus.PAID,
          sentAt: { not: null }
        },
        select: {
          id: true,
          sentAt: true
        }
      }),
      this.prisma.deal.findMany({
        where: {
          orgId,
          stage: DealStage.OPEN
        },
        select: {
          valueAmount: true,
          stage: true,
          expectedCloseDate: true
        }
      })
    ]);

    const paidInvoiceIds = paidInvoices.map((invoice) => invoice.id);
    const paidEvents =
      paidInvoiceIds.length === 0
        ? []
        : await this.prisma.activityLog.findMany({
            where: {
              orgId,
              entityType: ActivityEntityType.INVOICE,
              action: "MARK_PAID",
              entityId: { in: paidInvoiceIds }
            },
            select: {
              entityId: true,
              createdAt: true
            },
            orderBy: [{ entityId: "asc" }, { createdAt: "asc" }]
          });

    const paidAtByInvoiceId = new Map<string, Date>();
    for (const event of paidEvents) {
      if (!paidAtByInvoiceId.has(event.entityId)) {
        paidAtByInvoiceId.set(event.entityId, event.createdAt);
      }
    }

    const avgPaymentDelayDays = averagePaymentDelayDays(
      paidInvoices.map((invoice) => ({
        sentAt: invoice.sentAt,
        paidAt: paidAtByInvoiceId.get(invoice.id) ?? null
      }))
    );

    const { pipelineWeighted30, pipelineWeighted60 } = computePipelineWeightedForecast(
      openDeals.map((deal) => ({
        valueAmount: deal.valueAmount,
        stage: deal.stage,
        expectedCloseDate: deal.expectedCloseDate
      })),
      now
    );

    const invoicesForecast30 = Math.round(Number(invoicesForecast30Agg._sum.amount ?? 0));
    const invoicesForecast60 = Math.round(Number(invoicesForecast60Agg._sum.amount ?? 0));
    const outstandingReceivables = Math.round(Number(outstandingReceivablesAgg._sum.amount ?? 0));
    const next30DaysForecast = invoicesForecast30 + pipelineWeighted30;
    const next60DaysForecast = invoicesForecast60 + pipelineWeighted60;

    return {
      outstandingReceivables,
      avgPaymentDelayDays,
      next30DaysForecast,
      next60DaysForecast,
      breakdown: {
        invoices: {
          dueIn30: dueIn30Count,
          dueIn60: dueIn60Count,
          overdue: overdueCount
        },
        pipelineWeighted30,
        pipelineWeighted60
      }
    };
  }
}
