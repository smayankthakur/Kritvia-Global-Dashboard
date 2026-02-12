import { Injectable } from "@nestjs/common";
import { DealStage, InvoiceStatus, WorkItemStatus } from "@prisma/client";
import { AuthUserContext } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getCeoDashboard(authUser: AuthUserContext) {
    const today = startOfUtcDay(new Date());
    const nextWeek = new Date(today);
    nextWeek.setUTCDate(today.getUTCDate() + 7);

    const [openDealsAgg, overdueWorkCount, invoicesDueAgg, invoicesOverdueAgg, overdueWorkItems, overdueInvoices] =
      await Promise.all([
        this.prisma.deal.aggregate({
          where: { orgId: authUser.orgId, stage: DealStage.OPEN },
          _sum: { valueAmount: true }
        }),
        this.prisma.workItem.count({
          where: {
            orgId: authUser.orgId,
            status: { not: WorkItemStatus.DONE },
            dueDate: { lt: today }
          }
        }),
        this.prisma.invoice.aggregate({
          where: {
            orgId: authUser.orgId,
            status: { not: InvoiceStatus.PAID },
            dueDate: { gte: today, lte: nextWeek }
          },
          _sum: { amount: true }
        }),
        this.prisma.invoice.aggregate({
          where: {
            orgId: authUser.orgId,
            status: { not: InvoiceStatus.PAID },
            dueDate: { lt: today }
          },
          _sum: { amount: true }
        }),
        this.prisma.workItem.findMany({
          where: {
            orgId: authUser.orgId,
            status: { not: WorkItemStatus.DONE },
            dueDate: { lt: today }
          },
          orderBy: { dueDate: "asc" },
          take: 10,
          select: {
            id: true,
            title: true,
            status: true,
            dueDate: true,
            assignedToUserId: true,
            assignedToUser: { select: { id: true, name: true, email: true } },
            company: { select: { id: true, name: true } },
            deal: { select: { id: true, title: true } }
          }
        }),
        this.prisma.invoice.findMany({
          where: {
            orgId: authUser.orgId,
            status: { not: InvoiceStatus.PAID },
            dueDate: { lt: today }
          },
          orderBy: { dueDate: "asc" },
          take: 10,
          select: {
            id: true,
            invoiceNumber: true,
            amount: true,
            currency: true,
            status: true,
            dueDate: true,
            company: { select: { id: true, name: true } },
            deal: { select: { id: true, title: true } }
          }
        })
      ]);

    return {
      kpis: {
        openDealsValue: openDealsAgg._sum.valueAmount ?? 0,
        overdueWorkCount,
        invoicesDueTotal: Number(invoicesDueAgg._sum.amount ?? 0),
        invoicesOverdueTotal: Number(invoicesOverdueAgg._sum.amount ?? 0)
      },
      bottlenecks: {
        overdueWorkItems,
        overdueInvoices
      }
    };
  }
}
