import { Injectable } from "@nestjs/common";
import { InvoiceStatus, WorkItemStatus } from "@prisma/client";
import { AuthUserContext } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

@Injectable()
export class HygieneService {
  constructor(private readonly prisma: PrismaService) {}

  async getInbox(authUser: AuthUserContext) {
    const today = startOfUtcDay(new Date());

    const [workOverdue, workUnassigned, invoiceOverdue] = await Promise.all([
      this.prisma.workItem.findMany({
        where: {
          orgId: authUser.orgId,
          status: { not: WorkItemStatus.DONE },
          dueDate: { lt: today }
        },
        orderBy: { dueDate: "asc" },
        include: {
          assignedToUser: { select: { id: true, name: true, email: true } },
          company: { select: { id: true, name: true } },
          deal: { select: { id: true, title: true } }
        }
      }),
      this.prisma.workItem.findMany({
        where: {
          orgId: authUser.orgId,
          status: { not: WorkItemStatus.DONE },
          assignedToUserId: null
        },
        orderBy: { createdAt: "asc" },
        include: {
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
        include: {
          company: { select: { id: true, name: true } },
          deal: { select: { id: true, title: true } }
        }
      })
    ]);

    return [
      ...workOverdue.map((workItem) => ({
        type: "WORK_OVERDUE" as const,
        workItem,
        suggestedActions: ["NUDGE_OWNER", "CHANGE_DUE_DATE"]
      })),
      ...workUnassigned.map((workItem) => ({
        type: "WORK_UNASSIGNED" as const,
        workItem,
        suggestedActions: ["ASSIGN_OWNER"]
      })),
      ...invoiceOverdue.map((invoice) => ({
        type: "INVOICE_OVERDUE" as const,
        invoice: {
          ...invoice,
          effectiveStatus: "OVERDUE"
        },
        suggestedActions: ["NUDGE_FINANCE", "MARK_PAID"]
      }))
    ];
  }
}
