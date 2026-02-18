import { PrismaService } from "../src/prisma/prisma.service";
import { RiskEngineService } from "../src/graph/risk/risk-engine.service";

function makePrismaMock() {
  const graphNodeFindMany = jest.fn();
  const graphEdgeFindMany = jest.fn();
  const graphNodeUpdate = jest.fn().mockResolvedValue({});
  const upsertSnapshot = jest.fn().mockResolvedValue({});
  const findSnapshot = jest.fn();

  const prisma = {
    graphNode: {
      findMany: graphNodeFindMany,
      update: graphNodeUpdate
    },
    graphEdge: {
      findMany: graphEdgeFindMany
    },
    orgRiskSnapshot: {
      upsert: upsertSnapshot,
      findUnique: findSnapshot,
      findFirst: jest.fn()
    },
    $transaction: jest.fn((operations: Array<Promise<unknown>>) => Promise.all(operations))
  } as unknown as PrismaService;

  return {
    prisma,
    graphNodeFindMany,
    graphEdgeFindMany,
    findSnapshot
  };
}

describe("RiskEngineService deterministic scoring", () => {
  it("computes overdue invoice base risk with reason codes", async () => {
    const { prisma, graphNodeFindMany, graphEdgeFindMany, findSnapshot } = makePrismaMock();
    const now = new Date();

    graphNodeFindMany.mockResolvedValue([
      {
        id: "n-invoice",
        orgId: "org-1",
        type: "INVOICE",
        entityId: "invoice-1",
        title: "Invoice 1",
        status: "OVERDUE",
        amountCents: 250000,
        currency: "INR",
        dueAt: new Date(now.getTime() - 86_400_000),
        occurredAt: now,
        riskScore: 0,
        updatedAt: now
      }
    ]);
    graphEdgeFindMany.mockResolvedValue([]);
    findSnapshot.mockResolvedValue({ riskScore: 20 });

    const autoNudgeService = {
      generateRiskNudges: jest.fn().mockResolvedValue(undefined)
    } as unknown as import("../src/graph/risk/auto-nudge.service").AutoNudgeService;
    const service = new RiskEngineService(prisma, autoNudgeService);
    const result = await service.computeOrgRisk("org-1");

    expect(result.orgRiskScore).toBeGreaterThan(0);
    expect(result.topDrivers[0]?.reasonCodes).toContain("INVOICE_OVERDUE");
    expect(result.topDrivers[0]?.reasonCodes).toContain("INVOICE_HIGH_AMOUNT");
    expect(result.deltas.vsYesterday).toBe(result.orgRiskScore - 20);
  });

  it("propagates risk through edges to related nodes", async () => {
    const { prisma, graphNodeFindMany, graphEdgeFindMany, findSnapshot } = makePrismaMock();
    const now = new Date();

    graphNodeFindMany.mockResolvedValue([
      {
        id: "invoice-node",
        orgId: "org-1",
        type: "INVOICE",
        entityId: "inv-1",
        title: "Invoice",
        status: "OVERDUE",
        amountCents: 800000,
        currency: "INR",
        dueAt: new Date(now.getTime() - 86_400_000),
        occurredAt: now,
        riskScore: 0,
        updatedAt: now
      },
      {
        id: "company-node",
        orgId: "org-1",
        type: "COMPANY",
        entityId: "company-1",
        title: "Company",
        status: "ACTIVE",
        amountCents: null,
        currency: null,
        dueAt: null,
        occurredAt: now,
        riskScore: 0,
        updatedAt: now
      }
    ]);

    graphEdgeFindMany.mockResolvedValue([
      {
        id: "edge-1",
        fromNodeId: "invoice-node",
        toNodeId: "company-node",
        type: "RELATES_TO",
        weight: 1,
        createdAt: now
      }
    ]);

    findSnapshot.mockResolvedValue(null);

    const autoNudgeService = {
      generateRiskNudges: jest.fn().mockResolvedValue(undefined)
    } as unknown as import("../src/graph/risk/auto-nudge.service").AutoNudgeService;
    const service = new RiskEngineService(prisma, autoNudgeService);
    const result = await service.computeOrgRisk("org-1");

    const companyUpdate = result.nodeUpdates.find((item) => item.nodeId === "company-node");
    expect(companyUpdate).toBeDefined();
    expect(companyUpdate!.riskScore).toBeGreaterThan(0);
    expect(companyUpdate!.reasons).toContain("PROPAGATED_FROM_INVOICE");
  });

  it("returns snapshot delta from yesterday", async () => {
    const { prisma, graphNodeFindMany, graphEdgeFindMany, findSnapshot } = makePrismaMock();
    const now = new Date();

    graphNodeFindMany.mockResolvedValue([
      {
        id: "incident-node",
        orgId: "org-1",
        type: "INCIDENT",
        entityId: "inc-1",
        title: "Incident",
        status: "OPEN",
        amountCents: null,
        currency: null,
        dueAt: null,
        occurredAt: now,
        riskScore: 0,
        updatedAt: now
      }
    ]);
    graphEdgeFindMany.mockResolvedValue([]);
    findSnapshot.mockResolvedValue({ riskScore: 10 });

    const autoNudgeService = {
      generateRiskNudges: jest.fn().mockResolvedValue(undefined)
    } as unknown as import("../src/graph/risk/auto-nudge.service").AutoNudgeService;
    const service = new RiskEngineService(prisma, autoNudgeService);
    const result = await service.computeOrgRisk("org-1");

    expect(result.deltas.vsYesterday).toBe(result.orgRiskScore - 10);
  });

  it("calls auto-nudge generation after recompute when enabled", async () => {
    const { prisma, graphNodeFindMany, graphEdgeFindMany, findSnapshot } = makePrismaMock();
    const now = new Date();
    graphNodeFindMany.mockResolvedValue([
      {
        id: "n-invoice",
        orgId: "org-1",
        type: "INVOICE",
        entityId: "invoice-1",
        title: "Invoice 1",
        status: "OVERDUE",
        amountCents: 250000,
        currency: "INR",
        dueAt: new Date(now.getTime() - 86_400_000),
        occurredAt: now,
        riskScore: 0,
        updatedAt: now
      }
    ]);
    graphEdgeFindMany.mockResolvedValue([]);
    findSnapshot.mockResolvedValue(null);
    const autoNudgeService = {
      generateRiskNudges: jest.fn().mockResolvedValue(undefined)
    } as unknown as import("../src/graph/risk/auto-nudge.service").AutoNudgeService;
    const service = new RiskEngineService(prisma, autoNudgeService);

    await service.computeOrgRisk("org-1");
    expect(autoNudgeService.generateRiskNudges).toHaveBeenCalled();
  });
});
