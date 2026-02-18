import { ActivityLogService } from "../src/activity-log/activity-log.service";
import { AutopilotService } from "../src/autopilot/autopilot.service";
import { FixActionsService } from "../src/fix-actions/fix-actions.service";
import { PolicyResolverService } from "../src/policy/policy-resolver.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { RiskDriver } from "../src/graph/risk/risk-engine.service";

function makeDriver(overrides?: Partial<RiskDriver>): RiskDriver {
  return {
    nodeId: "node-1",
    entityId: "10000000-0000-0000-0000-000000000001",
    type: "INVOICE",
    title: "Invoice A",
    riskScore: 90,
    reasonCodes: ["INVOICE_OVERDUE"],
    evidence: {
      dueAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      amountCents: 120000,
      status: "OVERDUE"
    },
    ...overrides
  };
}

function setup() {
  const prisma = {
    autopilotPolicy: {
      findMany: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn()
    },
    autopilotRun: {
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn()
    },
    fixActionTemplate: {
      findFirst: jest.fn()
    },
    user: {
      findFirst: jest.fn()
    },
    $transaction: jest.fn()
  } as unknown as PrismaService;

  const policyResolver = {
    getPolicyForOrg: jest.fn().mockResolvedValue({ autopilotEnabled: true })
  } as unknown as PolicyResolverService;

  const fixActions = {
    previewRun: jest.fn(),
    createRun: jest.fn(),
    confirmRun: jest.fn()
  } as unknown as FixActionsService;

  const activityLog = {
    log: jest.fn().mockResolvedValue(undefined)
  } as unknown as ActivityLogService;

  return {
    prisma,
    policyResolver,
    fixActions,
    activityLog,
    service: new AutopilotService(prisma, policyResolver, fixActions, activityLog)
  };
}

describe("AutopilotService", () => {
  beforeEach(() => {
    process.env.FEATURE_AUTOPILOT_ENABLED = "true";
    process.env.FEATURE_AUTOPILOT = "true";
    process.env.KILL_SWITCH_AUTOPILOT = "false";
  });

  it("policy evaluation supports gt/gte/lt operators", () => {
    const { service } = setup();
    const evaluate = (service as unknown as { evaluateCondition: (c: unknown, ctx: Record<string, unknown>) => boolean }).evaluateCondition.bind(service);

    expect(evaluate({ field: "riskScore", op: "gt", value: 80 }, { riskScore: 81 })).toBe(true);
    expect(evaluate({ field: "riskScore", op: "gte", value: 80 }, { riskScore: 80 })).toBe(true);
    expect(evaluate({ field: "dueAtPastDays", op: "lt", value: 3 }, { dueAtPastDays: 2 })).toBe(true);
  });

  it("rate limit enforced at policy level", async () => {
    const { prisma, fixActions, service } = setup();

    (prisma.user.findFirst as jest.Mock).mockResolvedValue({
      id: "actor-1",
      role: "ADMIN",
      email: "admin@test.local",
      name: "Admin"
    });

    (prisma.autopilotPolicy.findMany as jest.Mock).mockResolvedValue([
      {
        id: "policy-1",
        orgId: "org-1",
        entityType: "INVOICE",
        condition: { field: "riskScore", op: "gte", value: 70 },
        actionTemplateKey: "SEND_INVOICE_REMINDER",
        riskThreshold: 70,
        autoExecute: true,
        maxExecutionsPerHour: 1
      }
    ]);

    (prisma.autopilotRun.create as jest.Mock).mockResolvedValue({ id: "run-1" });
    (fixActions.previewRun as jest.Mock).mockResolvedValue({ dryRun: true });
    (prisma.autopilotRun.count as jest.Mock).mockResolvedValue(1);

    await service.evaluateAndExecute("org-1", makeDriver());
    expect(prisma.autopilotRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SKIPPED" })
      })
    );
  });

  it("dry-run stores preview", async () => {
    const { prisma, fixActions, service } = setup();

    (prisma.user.findFirst as jest.Mock).mockResolvedValue({
      id: "actor-1",
      role: "ADMIN",
      email: "admin@test.local",
      name: "Admin"
    });

    (prisma.autopilotPolicy.findMany as jest.Mock).mockResolvedValue([
      {
        id: "policy-1",
        orgId: "org-1",
        entityType: "INVOICE",
        condition: { field: "riskScore", op: "gte", value: 70 },
        actionTemplateKey: "SEND_INVOICE_REMINDER",
        riskThreshold: 70,
        autoExecute: false,
        maxExecutionsPerHour: 10
      }
    ]);

    (prisma.autopilotRun.create as jest.Mock).mockResolvedValue({ id: "run-1" });
    (fixActions.previewRun as jest.Mock).mockResolvedValue({ dryRun: true, invoiceId: "inv-1" });
    (prisma.autopilotRun.count as jest.Mock).mockResolvedValue(0);
    (fixActions.createRun as jest.Mock).mockResolvedValue({ id: "fix-1", status: "PENDING" });

    await service.evaluateAndExecute("org-1", makeDriver({ riskScore: 95 }));
    expect(prisma.autopilotRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ preview: expect.objectContaining({ dryRun: true }) })
      })
    );
  });

  it("approval path creates approval-required run", async () => {
    const { prisma, fixActions, service } = setup();

    (prisma.user.findFirst as jest.Mock).mockResolvedValue({
      id: "actor-1",
      role: "ADMIN",
      email: "admin@test.local",
      name: "Admin"
    });

    (prisma.autopilotPolicy.findMany as jest.Mock).mockResolvedValue([
      {
        id: "policy-1",
        orgId: "org-1",
        entityType: "INVOICE",
        condition: { field: "riskScore", op: "gte", value: 70 },
        actionTemplateKey: "SEND_INVOICE_REMINDER",
        riskThreshold: 70,
        autoExecute: true,
        maxExecutionsPerHour: 10
      }
    ]);

    (prisma.autopilotRun.create as jest.Mock).mockResolvedValue({ id: "run-1" });
    (fixActions.previewRun as jest.Mock).mockResolvedValue({ dryRun: true });
    (prisma.autopilotRun.count as jest.Mock).mockResolvedValue(0);
    (fixActions.createRun as jest.Mock).mockResolvedValue({ id: "fix-1", status: "PENDING" });

    await service.evaluateAndExecute("org-1", makeDriver({ riskScore: 90 }));
    expect(prisma.autopilotRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "APPROVAL_REQUIRED" })
      })
    );
  });

  it("kill switch blocks execution", async () => {
    process.env.KILL_SWITCH_AUTOPILOT = "true";
    const { prisma, fixActions, service } = setup();

    (prisma.user.findFirst as jest.Mock).mockResolvedValue({
      id: "actor-1",
      role: "ADMIN",
      email: "admin@test.local",
      name: "Admin"
    });

    (prisma.autopilotPolicy.findMany as jest.Mock).mockResolvedValue([
      {
        id: "policy-1",
        orgId: "org-1",
        entityType: "INVOICE",
        condition: { field: "riskScore", op: "gte", value: 70 },
        actionTemplateKey: "SEND_INVOICE_REMINDER",
        riskThreshold: 70,
        autoExecute: true,
        maxExecutionsPerHour: 10
      }
    ]);

    (prisma.autopilotRun.create as jest.Mock).mockResolvedValue({ id: "run-1" });
    (fixActions.previewRun as jest.Mock).mockResolvedValue({ dryRun: true });
    (prisma.autopilotRun.count as jest.Mock).mockResolvedValue(0);
    (fixActions.createRun as jest.Mock).mockResolvedValue({ id: "fix-1", status: "PENDING" });

    await service.evaluateAndExecute("org-1", makeDriver({ riskScore: 60 }));
    expect(fixActions.confirmRun).not.toHaveBeenCalled();
    expect(prisma.autopilotRun.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SKIPPED" }) })
    );
  });
});
