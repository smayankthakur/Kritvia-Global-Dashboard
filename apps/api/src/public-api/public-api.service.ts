import { Injectable } from "@nestjs/common";
import { toPaginatedResponse } from "../common/dto/paginated-response.dto";
import { PrismaService } from "../prisma/prisma.service";
import { PublicListQueryDto } from "./dto/public-list-query.dto";

@Injectable()
export class PublicApiService {
  constructor(private readonly prisma: PrismaService) {}

  async listUsers(orgId: string, query: PublicListQueryDto) {
    const skip = (query.page - 1) * query.pageSize;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where: { orgId },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip,
        take: query.pageSize,
        select: {
          id: true,
          name: true,
          role: true,
          isActive: true,
          createdAt: true
        }
      }),
      this.prisma.user.count({ where: { orgId } })
    ]);

    return toPaginatedResponse(
      items.map((item) => ({
        id: item.id,
        name: item.name,
        role: item.role,
        isActive: item.isActive,
        createdAt: item.createdAt.toISOString()
      })),
      query.page,
      query.pageSize,
      total
    );
  }

  async listDeals(orgId: string, query: PublicListQueryDto) {
    const skip = (query.page - 1) * query.pageSize;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.deal.findMany({
        where: { orgId },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip,
        take: query.pageSize,
        select: {
          id: true,
          title: true,
          stage: true,
          isStale: true,
          valueAmount: true,
          currency: true,
          expectedCloseDate: true,
          wonAt: true,
          createdAt: true,
          updatedAt: true,
          company: {
            select: {
              id: true,
              name: true
            }
          },
          owner: {
            select: {
              id: true,
              name: true
            }
          }
        }
      }),
      this.prisma.deal.count({ where: { orgId } })
    ]);

    return toPaginatedResponse(
      items.map((item) => ({
        id: item.id,
        title: item.title,
        stage: item.stage,
        isStale: item.isStale,
        valueAmount: item.valueAmount,
        currency: item.currency,
        expectedCloseDate: item.expectedCloseDate ? item.expectedCloseDate.toISOString() : null,
        wonAt: item.wonAt ? item.wonAt.toISOString() : null,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
        company: item.company,
        owner: item.owner
      })),
      query.page,
      query.pageSize,
      total
    );
  }

  async listInvoices(orgId: string, query: PublicListQueryDto) {
    const skip = (query.page - 1) * query.pageSize;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.invoice.findMany({
        where: { orgId },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip,
        take: query.pageSize,
        select: {
          id: true,
          invoiceNumber: true,
          status: true,
          amount: true,
          currency: true,
          issueDate: true,
          dueDate: true,
          sentAt: true,
          lockedAt: true,
          createdAt: true,
          updatedAt: true,
          company: {
            select: {
              id: true,
              name: true
            }
          }
        }
      }),
      this.prisma.invoice.count({ where: { orgId } })
    ]);

    return toPaginatedResponse(
      items.map((item) => ({
        id: item.id,
        invoiceNumber: item.invoiceNumber,
        status: item.status,
        amount: Number(item.amount),
        currency: item.currency,
        issueDate: item.issueDate.toISOString(),
        dueDate: item.dueDate.toISOString(),
        sentAt: item.sentAt ? item.sentAt.toISOString() : null,
        lockedAt: item.lockedAt ? item.lockedAt.toISOString() : null,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
        company: item.company
      })),
      query.page,
      query.pageSize,
      total
    );
  }

  async listWorkItems(orgId: string, query: PublicListQueryDto) {
    const skip = (query.page - 1) * query.pageSize;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.workItem.findMany({
        where: { orgId },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip,
        take: query.pageSize,
        select: {
          id: true,
          title: true,
          status: true,
          priority: true,
          dueDate: true,
          createdAt: true,
          updatedAt: true,
          completedAt: true,
          assignedToUser: {
            select: {
              id: true,
              name: true
            }
          },
          deal: {
            select: {
              id: true,
              title: true,
              stage: true
            }
          }
        }
      }),
      this.prisma.workItem.count({ where: { orgId } })
    ]);

    return toPaginatedResponse(
      items.map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status,
        priority: item.priority,
        dueDate: item.dueDate ? item.dueDate.toISOString() : null,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
        completedAt: item.completedAt ? item.completedAt.toISOString() : null,
        assignedTo: item.assignedToUser,
        deal: item.deal
      })),
      query.page,
      query.pageSize,
      total
    );
  }

  async listInsights(orgId: string, query: PublicListQueryDto) {
    const skip = (query.page - 1) * query.pageSize;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.aIInsight.findMany({
        where: {
          orgId,
          isResolved: false
        },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip,
        take: query.pageSize,
        select: {
          id: true,
          type: true,
          severity: true,
          scoreImpact: true,
          title: true,
          explanation: true,
          entityType: true,
          entityId: true,
          createdAt: true
        }
      }),
      this.prisma.aIInsight.count({
        where: {
          orgId,
          isResolved: false
        }
      })
    ]);

    return toPaginatedResponse(
      items.map((item) => ({
        id: item.id,
        type: item.type,
        severity: item.severity,
        scoreImpact: item.scoreImpact,
        title: item.title,
        explanation: item.explanation,
        entityType: item.entityType,
        entityId: item.entityId,
        createdAt: item.createdAt.toISOString()
      })),
      query.page,
      query.pageSize,
      total
    );
  }

  async listActions(orgId: string, query: PublicListQueryDto) {
    const skip = (query.page - 1) * query.pageSize;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.aIAction.findMany({
        where: { orgId },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip,
        take: query.pageSize,
        select: {
          id: true,
          insightId: true,
          type: true,
          status: true,
          title: true,
          rationale: true,
          approvedAt: true,
          executedAt: true,
          error: true,
          createdAt: true
        }
      }),
      this.prisma.aIAction.count({ where: { orgId } })
    ]);

    return toPaginatedResponse(
      items.map((item) => ({
        id: item.id,
        insightId: item.insightId,
        type: item.type,
        status: item.status,
        title: item.title,
        rationale: item.rationale,
        approvedAt: item.approvedAt ? item.approvedAt.toISOString() : null,
        executedAt: item.executedAt ? item.executedAt.toISOString() : null,
        error: item.error,
        createdAt: item.createdAt.toISOString()
      })),
      query.page,
      query.pageSize,
      total
    );
  }
}
