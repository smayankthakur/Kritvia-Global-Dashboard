import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function toAmountCents(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.round(numeric * 100);
}

async function upsertDealNodes() {
  const deals = await prisma.deal.findMany({
    select: {
      id: true,
      orgId: true,
      title: true,
      stage: true,
      valueAmount: true,
      currency: true,
      createdAt: true,
      updatedAt: true
    }
  });

  let upserts = 0;
  for (const deal of deals) {
    await prisma.graphNode.upsert({
      where: {
        orgId_type_entityId: {
          orgId: deal.orgId,
          type: "DEAL",
          entityId: deal.id
        }
      },
      create: {
        orgId: deal.orgId,
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
        occurredAt: deal.createdAt,
        updatedAt: deal.updatedAt
      }
    });
    upserts += 1;
  }
  return upserts;
}

async function upsertWorkItemNodes() {
  const workItems = await prisma.workItem.findMany({
    select: {
      id: true,
      orgId: true,
      title: true,
      status: true,
      dueDate: true,
      dealId: true,
      createdAt: true,
      updatedAt: true
    }
  });

  let upserts = 0;
  for (const workItem of workItems) {
    await prisma.graphNode.upsert({
      where: {
        orgId_type_entityId: {
          orgId: workItem.orgId,
          type: "WORK_ITEM",
          entityId: workItem.id
        }
      },
      create: {
        orgId: workItem.orgId,
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
        occurredAt: workItem.createdAt,
        updatedAt: workItem.updatedAt
      }
    });
    upserts += 1;
  }
  return upserts;
}

async function upsertInvoiceNodes() {
  const invoices = await prisma.invoice.findMany({
    select: {
      id: true,
      orgId: true,
      invoiceNumber: true,
      status: true,
      amount: true,
      currency: true,
      dueDate: true,
      dealId: true,
      createdAt: true,
      updatedAt: true
    }
  });

  let upserts = 0;
  for (const invoice of invoices) {
    await prisma.graphNode.upsert({
      where: {
        orgId_type_entityId: {
          orgId: invoice.orgId,
          type: "INVOICE",
          entityId: invoice.id
        }
      },
      create: {
        orgId: invoice.orgId,
        type: "INVOICE",
        entityId: invoice.id,
        title: invoice.invoiceNumber ? `Invoice ${invoice.invoiceNumber}` : `Invoice ${invoice.id.slice(0, 8)}`,
        status: String(invoice.status),
        amountCents: toAmountCents(invoice.amount),
        currency: invoice.currency,
        dueAt: invoice.dueDate,
        occurredAt: invoice.createdAt
      },
      update: {
        title: invoice.invoiceNumber ? `Invoice ${invoice.invoiceNumber}` : `Invoice ${invoice.id.slice(0, 8)}`,
        status: String(invoice.status),
        amountCents: toAmountCents(invoice.amount),
        currency: invoice.currency,
        dueAt: invoice.dueDate,
        occurredAt: invoice.createdAt,
        updatedAt: invoice.updatedAt
      }
    });
    upserts += 1;
  }
  return upserts;
}

async function createEdges() {
  const [deals, workItems, invoices] = await Promise.all([
    prisma.deal.findMany({
      select: { id: true, orgId: true }
    }),
    prisma.workItem.findMany({
      where: { dealId: { not: null } },
      select: { id: true, orgId: true, dealId: true }
    }),
    prisma.invoice.findMany({
      where: { dealId: { not: null } },
      select: { id: true, orgId: true, dealId: true }
    })
  ]);

  const dealNodeIdByEntity = new Map<string, string>();
  for (const deal of deals) {
    const node = await prisma.graphNode.findUnique({
      where: {
        orgId_type_entityId: {
          orgId: deal.orgId,
          type: "DEAL",
          entityId: deal.id
        }
      },
      select: { id: true }
    });
    if (node) {
      dealNodeIdByEntity.set(`${deal.orgId}:${deal.id}`, node.id);
    }
  }

  let edgeUpserts = 0;
  for (const workItem of workItems) {
    const dealId = workItem.dealId;
    if (!dealId) {
      continue;
    }
    const fromNodeId = dealNodeIdByEntity.get(`${workItem.orgId}:${dealId}`);
    if (!fromNodeId) {
      continue;
    }
    const workItemNode = await prisma.graphNode.findUnique({
      where: {
        orgId_type_entityId: {
          orgId: workItem.orgId,
          type: "WORK_ITEM",
          entityId: workItem.id
        }
      },
      select: { id: true }
    });
    if (!workItemNode) {
      continue;
    }

    await prisma.graphEdge.upsert({
      where: {
        orgId_fromNodeId_toNodeId_type: {
          orgId: workItem.orgId,
          fromNodeId,
          toNodeId: workItemNode.id,
          type: "CREATED_FROM"
        }
      },
      create: {
        orgId: workItem.orgId,
        fromNodeId,
        toNodeId: workItemNode.id,
        type: "CREATED_FROM"
      },
      update: {}
    });
    edgeUpserts += 1;
  }

  for (const invoice of invoices) {
    const dealId = invoice.dealId;
    if (!dealId) {
      continue;
    }
    const fromNodeId = dealNodeIdByEntity.get(`${invoice.orgId}:${dealId}`);
    if (!fromNodeId) {
      continue;
    }
    const invoiceNode = await prisma.graphNode.findUnique({
      where: {
        orgId_type_entityId: {
          orgId: invoice.orgId,
          type: "INVOICE",
          entityId: invoice.id
        }
      },
      select: { id: true }
    });
    if (!invoiceNode) {
      continue;
    }
    await prisma.graphEdge.upsert({
      where: {
        orgId_fromNodeId_toNodeId_type: {
          orgId: invoice.orgId,
          fromNodeId,
          toNodeId: invoiceNode.id,
          type: "BILLED_BY"
        }
      },
      create: {
        orgId: invoice.orgId,
        fromNodeId,
        toNodeId: invoiceNode.id,
        type: "BILLED_BY"
      },
      update: {}
    });
    edgeUpserts += 1;
  }

  return edgeUpserts;
}

async function main() {
  console.log("[graph:backfill] Starting graph backfill for DEAL, WORK_ITEM, INVOICE");
  const dealNodes = await upsertDealNodes();
  const workItemNodes = await upsertWorkItemNodes();
  const invoiceNodes = await upsertInvoiceNodes();
  const edges = await createEdges();

  console.log(
    `[graph:backfill] Completed. nodes(deal=${dealNodes}, workItem=${workItemNodes}, invoice=${invoiceNodes}) edges=${edges}`
  );
}

main()
  .catch((error) => {
    console.error("[graph:backfill] Failed", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
