import { BadRequestException, INestApplication, ValidationError, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ActivityEntityType, DealStage, InvoiceStatus, Role } from "@prisma/client";
import cookieParser from "cookie-parser";
import { json, urlencoded } from "express";
import helmet from "helmet";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";
import { requestIdMiddleware } from "../src/common/middleware/request-id.middleware";
import { requestLoggingMiddleware } from "../src/common/middleware/request-logging.middleware";
import { PrismaService } from "../src/prisma/prisma.service";

jest.setTimeout(60000);

const IDS = {
  orgA: "10000000-0000-0000-0000-000000000001",
  companyA: "10000000-0000-0000-0000-000000000010",
  dealA: "10000000-0000-0000-0000-000000000020",
  invoiceA: "10000000-0000-0000-0000-000000000030"
} as const;

const PASSWORD = "kritviyaTest123!";

function collectValidationIssues(error: ValidationError): string[] {
  const currentIssues = error.constraints ? Object.values(error.constraints) : [];
  const childIssues = (error.children ?? []).flatMap((child) => collectValidationIssues(child));
  return [...currentIssues, ...childIssues];
}

function formatValidationDetails(errors: ValidationError[]): Array<{ field: string; issues: string[] }> {
  return errors
    .map((error) => ({
      field: error.property,
      issues: collectValidationIssues(error)
    }))
    .filter((detail) => detail.issues.length > 0);
}

async function login(app: INestApplication, email: string): Promise<string> {
  const response = await request(app.getHttpServer())
    .post("/auth/login")
    .send({ email, password: PASSWORD });

  expect(response.status).toBe(201);
  expect(response.body.accessToken).toBeDefined();
  return response.body.accessToken as string;
}

describe("Guardrail Integration Tests", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let salesAToken = "";
  let opsAToken = "";
  let financeAToken = "";
  let ceoAToken = "";
  let adminBToken = "";
  let validCompanyId = "";
  let validAssigneeUserId = "";

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule]
    }).compile();

    app = moduleRef.createNestApplication();
    const expressApp = app.getHttpAdapter().getInstance();
    expressApp.disable("x-powered-by");
    app.use(helmet());
    app.use(cookieParser());
    app.use(requestIdMiddleware);
    app.use(requestLoggingMiddleware);
    app.use(json({ limit: "1mb" }));
    app.use(urlencoded({ extended: true, limit: "1mb" }));
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        exceptionFactory: (errors: ValidationError[]) =>
          new BadRequestException({
            code: "VALIDATION_ERROR",
            message: "Invalid request.",
            details: formatValidationDetails(errors)
          })
      })
    );
    app.useGlobalFilters(new AllExceptionsFilter());

    await app.init();

    prisma = app.get(PrismaService);
    salesAToken = await login(app, "salesa@test.kritviya.local");
    opsAToken = await login(app, "opsa@test.kritviya.local");
    financeAToken = await login(app, "financea@test.kritviya.local");
    ceoAToken = await login(app, "ceoa@test.kritviya.local");
    adminBToken = await login(app, "adminb@test.kritviya.local");
    const company = await prisma.company.create({
      data: {
        orgId: IDS.orgA,
        name: `Test Company ${Date.now()}`
      }
    });
    validCompanyId = company.id;

    const assignee = await prisma.user.create({
      data: {
        orgId: IDS.orgA,
        name: "Assigned User",
        email: `assigned-${Date.now()}@test.kritviya.local`,
        role: Role.OPS,
        isActive: true,
        passwordHash: "not-used-for-login"
      }
    });
    validAssigneeUserId = assignee.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it("salesA can list companies (RBAC allow)", async () => {
    const response = await request(app.getHttpServer())
      .get("/companies")
      .set("Authorization", `Bearer ${salesAToken}`);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.items)).toBe(true);
  });

  it("opsA cannot access sales companies endpoint (RBAC deny)", async () => {
    const response = await request(app.getHttpServer())
      .get("/companies")
      .set("Authorization", `Bearer ${opsAToken}`);

    expect(response.status).toBe(403);
  });

  it("unauthenticated request to protected endpoint returns 401", async () => {
    const response = await request(app.getHttpServer()).get("/companies");
    expect(response.status).toBe(401);
  });

  it("cross-org company read returns 404 (no existence leak)", async () => {
    const response = await request(app.getHttpServer())
      .get(`/companies/${IDS.companyA}`)
      .set("Authorization", `Bearer ${adminBToken}`);

    expect(response.status).toBe(404);
  });

  it("cross-org deal patch returns 404 (no existence leak)", async () => {
    const response = await request(app.getHttpServer())
      .patch(`/deals/${IDS.dealA}`)
      .set("Authorization", `Bearer ${adminBToken}`)
      .send({ title: "Cross-org Update Attempt" });

    expect(response.status).toBe(404);
  });

  it("locked invoice blocks sensitive patch; unlock allows patch", async () => {
    await prisma.invoice.update({
      where: { id: IDS.invoiceA },
      data: {
        status: InvoiceStatus.DRAFT,
        lockedAt: null,
        lockedByUserId: null,
        amount: 10000,
        dueDate: new Date("2026-01-20")
      }
    });

    const sendResponse = await request(app.getHttpServer())
      .post(`/invoices/${IDS.invoiceA}/send`)
      .set("Authorization", `Bearer ${financeAToken}`);
    expect(sendResponse.status).toBe(201);
    expect(sendResponse.body.isLocked).toBe(true);

    const blockedPatch = await request(app.getHttpServer())
      .patch(`/invoices/${IDS.invoiceA}`)
      .set("Authorization", `Bearer ${financeAToken}`)
      .send({ amount: 12000 });
    expect(blockedPatch.status).toBe(409);
    expect(blockedPatch.body.error).toBeDefined();

    const unlockResponse = await request(app.getHttpServer())
      .post(`/invoices/${IDS.invoiceA}/unlock`)
      .set("Authorization", `Bearer ${financeAToken}`);
    expect(unlockResponse.status).toBe(201);
    expect(unlockResponse.body.isLocked).toBe(false);

    const allowedPatch = await request(app.getHttpServer())
      .patch(`/invoices/${IDS.invoiceA}`)
      .set("Authorization", `Bearer ${financeAToken}`)
      .send({ amount: 13000 });
    expect(allowedPatch.status).toBe(200);
    expect(allowedPatch.body.amount).toContain("13000");
  });

  it("deal mark-won is idempotent for root work item creation", async () => {
    await prisma.workItem.deleteMany({
      where: { orgId: IDS.orgA, dealId: IDS.dealA }
    });
    await prisma.deal.update({
      where: { id: IDS.dealA },
      data: { stage: DealStage.OPEN, wonAt: null }
    });

    const first = await request(app.getHttpServer())
      .post(`/deals/${IDS.dealA}/mark-won`)
      .set("Authorization", `Bearer ${salesAToken}`);
    expect(first.status).toBe(201);

    const second = await request(app.getHttpServer())
      .post(`/deals/${IDS.dealA}/mark-won`)
      .set("Authorization", `Bearer ${salesAToken}`);
    expect(second.status).toBe(201);

    const count = await prisma.workItem.count({
      where: {
        orgId: IDS.orgA,
        dealId: IDS.dealA
      }
    });
    expect(count).toBe(1);
  });

  it("invoice send/unlock/mark-paid write audit logs in org scope", async () => {
    await prisma.invoice.update({
      where: { id: IDS.invoiceA },
      data: {
        status: InvoiceStatus.DRAFT,
        lockedAt: null,
        lockedByUserId: null
      }
    });

    const send = await request(app.getHttpServer())
      .post(`/invoices/${IDS.invoiceA}/send`)
      .set("Authorization", `Bearer ${financeAToken}`);
    expect(send.status).toBe(201);

    const unlock = await request(app.getHttpServer())
      .post(`/invoices/${IDS.invoiceA}/unlock`)
      .set("Authorization", `Bearer ${financeAToken}`);
    expect(unlock.status).toBe(201);

    const paid = await request(app.getHttpServer())
      .post(`/invoices/${IDS.invoiceA}/mark-paid`)
      .set("Authorization", `Bearer ${financeAToken}`);
    expect(paid.status).toBe(201);

    const logs = await prisma.activityLog.findMany({
      where: {
        orgId: IDS.orgA,
        entityType: ActivityEntityType.INVOICE,
        entityId: IDS.invoiceA,
        action: { in: ["SEND", "UNLOCK", "MARK_PAID"] }
      }
    });

    expect(logs.some((log) => log.action === "SEND")).toBe(true);
    expect(logs.some((log) => log.action === "UNLOCK")).toBe(true);
    expect(logs.some((log) => log.action === "MARK_PAID")).toBe(true);
  });

  it("policy update validates numeric ranges", async () => {
    const response = await request(app.getHttpServer())
      .put("/settings/policies")
      .set("Authorization", `Bearer ${ceoAToken}`)
      .send({
        lockInvoiceOnSent: true,
        overdueAfterDays: 0,
        defaultWorkDueDays: 31,
        staleDealAfterDays: 0,
        leadStaleAfterHours: 24,
        requireDealOwner: true,
        requireWorkOwner: true,
        requireWorkDueDate: true,
        autoLockInvoiceAfterDays: 31,
        preventInvoiceUnlockAfterPartialPayment: true,
        autopilotEnabled: false,
        autopilotCreateWorkOnDealStageChange: true,
        autopilotNudgeOnOverdue: true,
        autopilotAutoStaleDeals: true,
        auditRetentionDays: 10,
        securityEventRetentionDays: 180,
        ipRestrictionEnabled: false,
        ipAllowlist: []
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("ceo can update policies with valid payload", async () => {
    const response = await request(app.getHttpServer())
      .put("/settings/policies")
      .set("Authorization", `Bearer ${ceoAToken}`)
      .send({
        lockInvoiceOnSent: true,
        overdueAfterDays: 3,
        defaultWorkDueDays: 5,
        staleDealAfterDays: 10,
        leadStaleAfterHours: 72,
        requireDealOwner: true,
        requireWorkOwner: true,
        requireWorkDueDate: true,
        autoLockInvoiceAfterDays: 2,
        preventInvoiceUnlockAfterPartialPayment: true,
        autopilotEnabled: false,
        autopilotCreateWorkOnDealStageChange: true,
        autopilotNudgeOnOverdue: true,
        autopilotAutoStaleDeals: true,
        auditRetentionDays: 180,
        securityEventRetentionDays: 180,
        ipRestrictionEnabled: false,
        ipAllowlist: []
      });

    expect(response.status).toBe(200);
    expect(response.body.defaultWorkDueDays).toBe(5);
    expect(response.body.staleDealAfterDays).toBe(10);
  });

  it("ops cannot access settings policies endpoints", async () => {
    const response = await request(app.getHttpServer())
      .get("/settings/policies")
      .set("Authorization", `Bearer ${opsAToken}`);

    expect(response.status).toBe(403);
  });

  it("settings policies endpoint is org scoped", async () => {
    const response = await request(app.getHttpServer())
      .get("/settings/policies")
      .set("Authorization", `Bearer ${adminBToken}`);

    expect(response.status).toBe(200);
    expect(response.body.orgId).toBe("20000000-0000-0000-0000-000000000001");
    expect(response.body.defaultWorkDueDays).toBe(3);
  });

  it("deal create without owner is blocked when policy requires owner", async () => {
    await prisma.policy.update({
      where: { orgId: IDS.orgA },
      data: { requireDealOwner: true }
    });

    const response = await request(app.getHttpServer())
      .post("/deals")
      .set("Authorization", `Bearer ${salesAToken}`)
      .send({
        title: "Ownerless Deal",
        companyId: validCompanyId,
        valueAmount: 1000
      });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain("owner is required");
  });

  it("work create without dueDate auto-sets dueDate and logs AUTO_DUE_DATE_SET", async () => {
    await prisma.policy.update({
      where: { orgId: IDS.orgA },
      data: { requireWorkDueDate: true, defaultWorkDueDays: 3, requireWorkOwner: true }
    });

    const response = await request(app.getHttpServer())
      .post("/work-items")
      .set("Authorization", `Bearer ${opsAToken}`)
      .send({
        title: "Policy Auto Due Work",
        assignedToUserId: validAssigneeUserId,
        priority: 2
      });

    expect(response.status).toBe(201);
    expect(response.body.dueDate).toBeTruthy();

    const logs = await prisma.activityLog.findMany({
      where: {
        orgId: IDS.orgA,
        entityType: ActivityEntityType.WORK_ITEM,
        entityId: response.body.id,
        action: "AUTO_DUE_DATE_SET"
      }
    });
    expect(logs.length).toBeGreaterThan(0);
  });

  it("invoice send sets lockAt using policy autoLockInvoiceAfterDays", async () => {
    await prisma.policy.update({
      where: { orgId: IDS.orgA },
      data: { autoLockInvoiceAfterDays: 2 }
    });
    await prisma.invoice.update({
      where: { id: IDS.invoiceA },
      data: {
        status: InvoiceStatus.DRAFT,
        sentAt: null,
        lockAt: null,
        lockedAt: null,
        lockedByUserId: null
      }
    });

    const response = await request(app.getHttpServer())
      .post(`/invoices/${IDS.invoiceA}/send`)
      .set("Authorization", `Bearer ${financeAToken}`);

    expect(response.status).toBe(201);
    expect(response.body.sentAt).toBeTruthy();
    expect(response.body.lockAt).toBeTruthy();

    const sentAt = new Date(response.body.sentAt);
    const lockAt = new Date(response.body.lockAt);
    const diffDays = Math.round((lockAt.getTime() - sentAt.getTime()) / (24 * 60 * 60 * 1000));
    expect(diffDays).toBe(2);
  });
});
