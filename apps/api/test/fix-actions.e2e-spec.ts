import { ForbiddenException } from "@nestjs/common";
import { Role } from "@prisma/client";
import { ActivityLogService } from "../src/activity-log/activity-log.service";
import { FixActionsService } from "../src/fix-actions/fix-actions.service";
import { PrismaService } from "../src/prisma/prisma.service";

function createPrismaMock() {
  return {
    fixActionTemplate: {
      findMany: jest.fn(),
      findFirst: jest.fn()
    },
    fixActionRun: {
      count: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn()
    },
    invoice: {
      findFirst: jest.fn()
    },
    workItem: {
      findFirst: jest.fn(),
      update: jest.fn()
    },
    incident: {
      findFirst: jest.fn()
    },
    nudge: {
      findFirst: jest.fn(),
      create: jest.fn()
    },
    user: {
      findFirst: jest.fn()
    },
    contact: {
      findFirst: jest.fn()
    },
    incidentTimeline: {
      create: jest.fn()
    },
    $transaction: jest.fn()
  } as unknown as PrismaService;
}

function createActivityLogMock() {
  return {
    log: jest.fn()
  } as unknown as ActivityLogService;
}

function authUser(role: Role) {
  return {
    userId: "user-1",
    orgId: "org-1",
    role,
    email: "user@test.local",
    name: "User"
  };
}

describe("FixActionsService", () => {
  beforeEach(() => {
    process.env.FEATURE_FIX_ACTIONS = "true";
    process.env.FEATURE_FIX_ACTIONS_EXECUTION = "true";
    process.env.RESEND_API_KEY = "";
  });

  it("creating run enforces role permissions", async () => {
    const prisma = createPrismaMock();
    const activityLog = createActivityLogMock();
    const service = new FixActionsService(prisma, activityLog);

    (prisma.fixActionRun.count as jest.Mock).mockResolvedValue(0);
    (prisma.fixActionTemplate.findFirst as jest.Mock).mockResolvedValue({
      id: "tpl-1",
      key: "SEND_INVOICE_REMINDER",
      title: "Send",
      description: null,
      requiresConfirmation: true,
      allowedRoles: ["FINANCE", "ADMIN", "CEO"],
      config: null,
      isEnabled: true,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    await expect(
      service.createRun(authUser(Role.OPS), {
        templateKey: "SEND_INVOICE_REMINDER",
        entityType: "INVOICE",
        entityId: "10000000-0000-0000-0000-000000000001"
      })
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("confirm transitions PENDING to SUCCEEDED for invoice reminder (simulated)", async () => {
    const prisma = createPrismaMock();
    const activityLog = createActivityLogMock();
    const service = new FixActionsService(prisma, activityLog);

    const run = {
      id: "run-1",
      orgId: "org-1",
      templateId: "tpl-1",
      entityType: "INVOICE",
      entityId: "10000000-0000-0000-0000-000000000001",
      requestedByUserId: "user-1",
      status: "PENDING",
      idempotencyKey: "k",
      input: null,
      result: null,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      nudgeId: null,
      template: {
        id: "tpl-1",
        key: "SEND_INVOICE_REMINDER",
        title: "Send",
        description: null,
        requiresConfirmation: true,
        allowedRoles: ["FINANCE", "ADMIN", "CEO"],
        config: null,
        isEnabled: true,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    };

    (prisma.fixActionRun.findFirst as jest.Mock).mockResolvedValue(run);
    (prisma.fixActionRun.findUnique as jest.Mock).mockResolvedValue({ ...run, status: "CONFIRMED" });
    (prisma.fixActionRun.update as jest.Mock)
      .mockResolvedValueOnce({ ...run, status: "CONFIRMED" })
      .mockResolvedValueOnce({ ...run, status: "RUNNING" })
      .mockResolvedValueOnce({ ...run, status: "SUCCEEDED" });
    (prisma.invoice.findFirst as jest.Mock).mockResolvedValue({
      id: run.entityId,
      orgId: "org-1",
      status: "SENT",
      amount: 1000,
      companyId: "company-1",
      company: { id: "company-1", name: "ACME" }
    });
    (prisma.contact.findFirst as jest.Mock).mockResolvedValue({ email: "client@acme.com" });
    (prisma.fixActionRun.findFirst as jest.Mock)
      .mockResolvedValueOnce(run)
      .mockResolvedValueOnce(null);

    const result = await service.confirmRun(authUser(Role.ADMIN), run.id, true);
    expect((result as { status: string }).status).toBe("SUCCEEDED");
  });

  it("work reassignment updates assignee and logs activity", async () => {
    const prisma = createPrismaMock();
    const activityLog = createActivityLogMock();
    const service = new FixActionsService(prisma, activityLog);

    const run = {
      id: "run-2",
      orgId: "org-1",
      templateId: "tpl-2",
      entityType: "WORK_ITEM",
      entityId: "20000000-0000-0000-0000-000000000001",
      requestedByUserId: "user-1",
      status: "CONFIRMED",
      idempotencyKey: "wk-1",
      input: { assigneeUserId: "assignee-2", reason: "Load balancing" },
      result: null,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      nudgeId: null,
      template: {
        id: "tpl-2",
        key: "REASSIGN_WORK",
        title: "Reassign",
        description: null,
        requiresConfirmation: true,
        allowedRoles: ["OPS", "ADMIN", "CEO"],
        config: null,
        isEnabled: true,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    };

    (prisma.fixActionRun.findUnique as jest.Mock).mockResolvedValue(run);
    (prisma.fixActionRun.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.fixActionRun.update as jest.Mock)
      .mockResolvedValueOnce({ ...run, status: "RUNNING" })
      .mockResolvedValueOnce({ ...run, status: "SUCCEEDED" });

    (prisma.workItem.findFirst as jest.Mock).mockResolvedValue({
      id: run.entityId,
      orgId: "org-1",
      assignedToUserId: "assignee-1"
    });
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: "assignee-2", name: "Ops 2", email: "ops2@test.local" });
    (prisma.workItem.update as jest.Mock).mockResolvedValue({
      id: run.entityId,
      assignedToUserId: "assignee-2"
    });

    const result = await (service as unknown as { executeRunInternal: (runId: string, user: ReturnType<typeof authUser>, bypass: boolean) => Promise<{ status: string }> }).executeRunInternal(run.id, authUser(Role.OPS), false);
    expect(result.status).toBe("SUCCEEDED");
    expect(prisma.workItem.update).toHaveBeenCalled();
    expect(activityLog.log).toHaveBeenCalled();
  });

  it("idempotency returns existing run without duplicate create", async () => {
    const prisma = createPrismaMock();
    const activityLog = createActivityLogMock();
    const service = new FixActionsService(prisma, activityLog);

    (prisma.fixActionRun.count as jest.Mock).mockResolvedValue(0);
    (prisma.fixActionTemplate.findFirst as jest.Mock).mockResolvedValue({
      id: "tpl-1",
      key: "SEND_INVOICE_REMINDER",
      title: "Send",
      description: null,
      requiresConfirmation: true,
      allowedRoles: ["FINANCE", "ADMIN", "CEO"],
      config: null,
      isEnabled: true,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    (prisma.invoice.findFirst as jest.Mock).mockResolvedValue({ id: "inv-1" });
    (prisma.fixActionRun.findFirst as jest.Mock).mockResolvedValue({
      id: "existing-run",
      status: "PENDING",
      idempotencyKey: "idem"
    });

    const result = await service.createRun(authUser(Role.FINANCE), {
      templateKey: "SEND_INVOICE_REMINDER",
      entityType: "INVOICE",
      entityId: "10000000-0000-0000-0000-000000000001",
      idempotencyKey: "idem"
    });

    expect(result.id).toBe("existing-run");
    expect(prisma.fixActionRun.create).not.toHaveBeenCalled();
  });

  it("rate limit blocks when more than 30 runs/hour", async () => {
    const prisma = createPrismaMock();
    const activityLog = createActivityLogMock();
    const service = new FixActionsService(prisma, activityLog);

    (prisma.fixActionRun.count as jest.Mock).mockResolvedValue(30);

    await expect(
      service.createRun(authUser(Role.ADMIN), {
        templateKey: "ESCALATE_INCIDENT",
        entityType: "INCIDENT",
        entityId: "30000000-0000-0000-0000-000000000001"
      })
    ).rejects.toThrow("rate limit");
  });
});
