import { ActivityLogService } from "../src/activity-log/activity-log.service";
import { AutoNudgeService } from "../src/graph/risk/auto-nudge.service";
import { RiskDriver } from "../src/graph/risk/risk-engine.service";
import { PrismaService } from "../src/prisma/prisma.service";

function driver(overrides?: Partial<{
  nodeId: string;
  entityId: string;
  type: string;
  riskScore: number;
  reasonCodes: RiskDriver["reasonCodes"];
}>): RiskDriver {
  return {
    nodeId: "node-1",
    entityId: "entity-1",
    type: "INVOICE",
    title: "Invoice A",
    riskScore: 90,
    reasonCodes: ["INVOICE_OVERDUE"],
    evidence: {
      status: "OVERDUE",
      amountCents: 150000,
      dueAt: "2026-02-17T00:00:00.000Z"
    },
    deeplink: { url: "/finance/invoices/entity-1", label: "Invoice" },
    ...overrides
  };
}

function setup() {
  const prisma = {
    nudge: {
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: "nudge-1", createdAt: new Date(), meta: null }),
      findMany: jest.fn().mockResolvedValue([])
    },
    user: {
      findFirst: jest.fn()
    },
    orgRiskSnapshot: {
      findFirst: jest.fn()
    }
  } as unknown as PrismaService;

  const activityLogService = {
    log: jest.fn().mockResolvedValue(undefined)
  } as unknown as ActivityLogService;

  return {
    prisma,
    activityLogService,
    service: new AutoNudgeService(prisma, activityLogService)
  };
}

describe("AutoNudgeService", () => {
  it("generates nudges with uniqueKey and dedupes on rerun", async () => {
    const { prisma, service } = setup();

    (prisma.user.findFirst as jest.Mock).mockImplementation(({ where }: { where: { role?: string } }) => {
      if (where.role === "FINANCE") {
        return Promise.resolve({ id: "finance-user" });
      }
      if (where.role === "ADMIN") {
        return Promise.resolve({ id: "admin-user" });
      }
      return Promise.resolve(null);
    });

    const firstRun = await service.generateRiskNudges("org-1", [driver()], new Date("2026-02-18T00:00:00.000Z"));
    expect(firstRun.created).toBe(1);

    const createdPayload = (prisma.nudge.create as jest.Mock).mock.calls[0][0].data;
    expect(createdPayload.uniqueKey).toBe(
      "org-1:RISK_INVOICE_OVERDUE:INVOICE:entity-1:2026-02-18"
    );

    (prisma.nudge.findUnique as jest.Mock).mockResolvedValue({ id: "nudge-1" });
    const secondRun = await service.generateRiskNudges("org-1", [driver()], new Date("2026-02-18T00:00:00.000Z"));
    expect(secondRun.created).toBe(0);
    expect(secondRun.skipped).toBeGreaterThanOrEqual(1);
  });

  it("assignment selects preferred role then fallback", async () => {
    const { prisma, service } = setup();

    (prisma.user.findFirst as jest.Mock).mockImplementation(({ where }: { where: { role?: string } }) => {
      if (where.role === "FINANCE") {
        return Promise.resolve(null);
      }
      if (where.role === "ADMIN") {
        return Promise.resolve({ id: "admin-user" });
      }
      return Promise.resolve(null);
    });

    await service.generateRiskNudges("org-1", [driver()], new Date("2026-02-18T00:00:00.000Z"));

    const createdPayload = (prisma.nudge.create as jest.Mock).mock.calls[0][0].data;
    expect(createdPayload.targetUserId).toBe("admin-user");
  });

  it("enforces daily cap", async () => {
    const { prisma, service } = setup();
    (prisma.nudge.count as jest.Mock).mockResolvedValue(20);

    const result = await service.generateRiskNudges("org-1", [driver(), driver({ entityId: "entity-2", nodeId: "node-2" })], new Date("2026-02-18T00:00:00.000Z"));

    expect(result.created).toBe(0);
    expect(result.capped).toBe(true);
    expect(prisma.nudge.create).not.toHaveBeenCalled();
  });
});
