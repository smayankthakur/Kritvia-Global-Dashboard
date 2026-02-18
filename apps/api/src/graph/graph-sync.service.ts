import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

type JsonObject = Prisma.InputJsonObject;

function toAmountCents(value: Prisma.Decimal | number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.round(numeric * 100);
}

@Injectable()
export class GraphSyncService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertNodeFromDeal(orgId: string, dealId: string): Promise<string> {
    const deal = await this.prisma.deal.findFirst({
      where: { id: dealId, orgId },
      select: {
        id: true,
        orgId: true,
        title: true,
        stage: true,
        valueAmount: true,
        currency: true,
        companyId: true,
        createdAt: true
      }
    });
    if (!deal) {
      throw new NotFoundException("Deal not found");
    }

    const node = await this.prisma.graphNode.upsert({
      where: {
        orgId_type_entityId: {
          orgId,
          type: "DEAL",
          entityId: deal.id
        }
      },
      create: {
        orgId,
        type: "DEAL",
        entityId: deal.id,
        title: deal.title,
        status: String(deal.stage),
        amountCents: deal.valueAmount ?? null,
        currency: deal.currency,
        occurredAt: deal.createdAt
      },
      update: {
        title: deal.title,
        status: String(deal.stage),
        amountCents: deal.valueAmount ?? null,
        currency: deal.currency,
        occurredAt: deal.createdAt
      },
      select: { id: true }
    });

    if (deal.companyId) {
      const companyNode = await this.upsertNodeFromCompany(orgId, deal.companyId);
      if (companyNode) {
        await this.ensureEdge(orgId, node.id, companyNode, "RELATES_TO");
      }
    }

    return node.id;
  }

  async upsertNodeFromWorkItem(orgId: string, workItemId: string): Promise<string> {
    const workItem = await this.prisma.workItem.findFirst({
      where: { id: workItemId, orgId },
      select: {
        id: true,
        orgId: true,
        title: true,
        status: true,
        dueDate: true,
        dealId: true,
        assignedToUserId: true,
        companyId: true,
        createdAt: true
      }
    });
    if (!workItem) {
      throw new NotFoundException("Work item not found");
    }

    const node = await this.prisma.graphNode.upsert({
      where: {
        orgId_type_entityId: {
          orgId,
          type: "WORK_ITEM",
          entityId: workItem.id
        }
      },
      create: {
        orgId,
        type: "WORK_ITEM",
        entityId: workItem.id,
        title: workItem.title,
        status: String(workItem.status),
        dueAt: workItem.dueDate,
        occurredAt: workItem.createdAt
      },
      update: {
        title: workItem.title,
        status: String(workItem.status),
        dueAt: workItem.dueDate,
        occurredAt: workItem.createdAt
      },
      select: { id: true }
    });

    if (workItem.dealId) {
      const dealNodeId = await this.upsertNodeFromDeal(orgId, workItem.dealId);
      await this.ensureEdge(orgId, dealNodeId, node.id, "CREATED_FROM");
    }

    if (workItem.assignedToUserId) {
      const userNode = await this.upsertNodeFromUser(orgId, workItem.assignedToUserId);
      if (userNode) {
        await this.ensureEdge(orgId, node.id, userNode, "ASSIGNED_TO");
      }
    }

    if (workItem.companyId) {
      const companyNode = await this.upsertNodeFromCompany(orgId, workItem.companyId);
      if (companyNode) {
        await this.ensureEdge(orgId, node.id, companyNode, "RELATES_TO");
      }
    }

    return node.id;
  }

  async upsertNodeFromInvoice(orgId: string, invoiceId: string): Promise<string> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, orgId },
      select: {
        id: true,
        orgId: true,
        invoiceNumber: true,
        status: true,
        amount: true,
        currency: true,
        dueDate: true,
        dealId: true,
        companyId: true,
        createdAt: true
      }
    });
    if (!invoice) {
      throw new NotFoundException("Invoice not found");
    }

    const title = invoice.invoiceNumber
      ? `Invoice ${invoice.invoiceNumber}`
      : `Invoice ${invoice.id.slice(0, 8)}`;

    const node = await this.prisma.graphNode.upsert({
      where: {
        orgId_type_entityId: {
          orgId,
          type: "INVOICE",
          entityId: invoice.id
        }
      },
      create: {
        orgId,
        type: "INVOICE",
        entityId: invoice.id,
        title,
        status: String(invoice.status),
        amountCents: toAmountCents(invoice.amount),
        currency: invoice.currency,
        dueAt: invoice.dueDate,
        occurredAt: invoice.createdAt
      },
      update: {
        title,
        status: String(invoice.status),
        amountCents: toAmountCents(invoice.amount),
        currency: invoice.currency,
        dueAt: invoice.dueDate,
        occurredAt: invoice.createdAt
      },
      select: { id: true }
    });

    if (invoice.dealId) {
      const dealNodeId = await this.upsertNodeFromDeal(orgId, invoice.dealId);
      await this.ensureEdge(orgId, dealNodeId, node.id, "BILLED_BY");
    }

    if (invoice.companyId) {
      const companyNode = await this.upsertNodeFromCompany(orgId, invoice.companyId);
      if (companyNode) {
        await this.ensureEdge(orgId, node.id, companyNode, "RELATES_TO");
      }
    }

    return node.id;
  }

  async ensureEdge(
    orgId: string,
    fromNodeId: string,
    toNodeId: string,
    type: string,
    meta?: JsonObject
  ): Promise<string> {
    const edge = await this.prisma.graphEdge.upsert({
      where: {
        orgId_fromNodeId_toNodeId_type: {
          orgId,
          fromNodeId,
          toNodeId,
          type
        }
      },
      create: {
        orgId,
        fromNodeId,
        toNodeId,
        type,
        ...(meta ? { meta } : {})
      },
      update: meta ? { meta } : {},
      select: { id: true }
    });
    return edge.id;
  }

  private async upsertNodeFromCompany(orgId: string, companyId: string): Promise<string | null> {
    const company = await this.prisma.company.findFirst({
      where: { id: companyId, orgId },
      select: { id: true, name: true, createdAt: true }
    });
    if (!company) {
      return null;
    }

    const node = await this.prisma.graphNode.upsert({
      where: {
        orgId_type_entityId: {
          orgId,
          type: "COMPANY",
          entityId: company.id
        }
      },
      create: {
        orgId,
        type: "COMPANY",
        entityId: company.id,
        title: company.name,
        occurredAt: company.createdAt
      },
      update: {
        title: company.name,
        occurredAt: company.createdAt
      },
      select: { id: true }
    });
    return node.id;
  }

  private async upsertNodeFromUser(orgId: string, userId: string): Promise<string | null> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, orgId },
      select: { id: true, name: true, role: true, createdAt: true }
    });
    if (!user) {
      return null;
    }

    const node = await this.prisma.graphNode.upsert({
      where: {
        orgId_type_entityId: {
          orgId,
          type: "USER",
          entityId: user.id
        }
      },
      create: {
        orgId,
        type: "USER",
        entityId: user.id,
        title: user.name,
        status: String(user.role),
        occurredAt: user.createdAt
      },
      update: {
        title: user.name,
        status: String(user.role),
        occurredAt: user.createdAt
      },
      select: { id: true }
    });
    return node.id;
  }
}
