import { BadRequestException, INestApplication, ValidationError, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { InvoiceStatus, Role, WorkItemStatus } from "@prisma/client";
import cookieParser from "cookie-parser";
import { json, urlencoded } from "express";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";
import { requestIdMiddleware } from "../src/common/middleware/request-id.middleware";
import { requestLoggingMiddleware } from "../src/common/middleware/request-logging.middleware";
import { PrismaService } from "../src/prisma/prisma.service";

jest.setTimeout(60000);

const PASSWORD = "kritviyaTest123!";
const ORG_A = "10000000-0000-0000-0000-000000000001";

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
  return response.body.accessToken as string;
}

describe("Autopilot Jobs Runner Integration", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken = "";
  let salesToken = "";
  let financeUserId = "";
  let opsUserId = "";
  let companyId = "";
  let dealId = "";
  let invoiceId = "";
  let workItemId = "";

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
    adminToken = await login(app, "admina@test.kritviya.local");
    salesToken = await login(app, "salesa@test.kritviya.local");

    const finance = await prisma.user.findFirst({
      where: { orgId: ORG_A, role: Role.FINANCE },
      select: { id: true }
    });
    const ops = await prisma.user.findFirst({
      where: { orgId: ORG_A, role: Role.OPS },
      select: { id: true }
    });
    if (!finance || !ops) {
      throw new Error("Missing seeded users for jobs test");
    }
    financeUserId = finance.id;
    opsUserId = ops.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it("runs jobs and remains idempotent across repeated calls", async () => {
    await prisma.policy.update({
      where: { orgId: ORG_A },
      data: {
        autopilotEnabled: true,
        autopilotNudgeOnOverdue: true,
        staleDealAfterDays: 1,
        autoLockInvoiceAfterDays: 0
      }
    });

    companyId = randomUUID();
    await prisma.company.create({
      data: {
        id: companyId,
        orgId: ORG_A,
        name: `Autopilot Test Co ${Date.now()}`
      }
    });

    dealId = randomUUID();
    await prisma.deal.create({
      data: {
        id: dealId,
        orgId: ORG_A,
        title: "Autopilot stale candidate",
        companyId,
        stage: "OPEN",
        ownerUserId: opsUserId
      }
    });
    await prisma.$executeRawUnsafe(
      `UPDATE deals SET updated_at = NOW() - INTERVAL '10 days' WHERE id = '${dealId}'`
    );

    invoiceId = randomUUID();
    await prisma.invoice.create({
      data: {
        id: invoiceId,
        orgId: ORG_A,
        companyId,
        dealId,
        status: InvoiceStatus.SENT,
        amount: 5000,
        currency: "INR",
        issueDate: new Date("2026-01-01"),
        dueDate: new Date("2026-01-05"),
        sentAt: new Date("2026-01-01T00:00:00.000Z"),
        lockAt: new Date("2026-01-02T00:00:00.000Z"),
        createdByUserId: financeUserId
      }
    });

    workItemId = randomUUID();
    await prisma.workItem.create({
      data: {
        id: workItemId,
        orgId: ORG_A,
        title: "Autopilot overdue work",
        status: WorkItemStatus.TODO,
        dueDate: new Date("2026-01-03"),
        assignedToUserId: opsUserId,
        createdByUserId: financeUserId,
        companyId
      }
    });

    const first = await request(app.getHttpServer())
      .post("/jobs/run")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(first.status).toBe(201);
    expect(first.body.invoicesLocked).toBeGreaterThanOrEqual(1);
    expect(first.body.dealsStaled).toBeGreaterThanOrEqual(1);
    expect(first.body.nudgesCreated).toBeGreaterThanOrEqual(2);

    const second = await request(app.getHttpServer())
      .post("/jobs/run")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(second.status).toBe(201);
    expect(second.body.invoicesLocked).toBe(0);
    expect(second.body.dealsStaled).toBe(0);

    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(invoice.lockedAt).toBeTruthy();

    const deal = await prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
    expect(deal.isStale).toBe(true);

    const workNudges = await prisma.nudge.findMany({
      where: {
        orgId: ORG_A,
        entityType: "WORK_ITEM",
        entityId: workItemId,
        status: "OPEN"
      }
    });
    const invoiceNudges = await prisma.nudge.findMany({
      where: {
        orgId: ORG_A,
        entityType: "INVOICE",
        entityId: invoiceId,
        status: "OPEN"
      }
    });

    expect(workNudges.length).toBe(1);
    expect(invoiceNudges.length).toBe(1);

    const listResponse = await request(app.getHttpServer())
      .get("/nudges?mine=false&status=OPEN")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(listResponse.status).toBe(200);
    expect(Array.isArray(listResponse.body.items)).toBe(true);
    expect(listResponse.body.items.length).toBeGreaterThanOrEqual(2);
    expect(listResponse.body.items[0].priorityScore).toBeGreaterThanOrEqual(
      listResponse.body.items[1].priorityScore
    );
    expect(listResponse.body.items[0].severity).toBeDefined();
    expect(listResponse.body.items[0].meta).toBeDefined();
  });

  it("blocks non-admin calls without matching jobs secret", async () => {
    const response = await request(app.getHttpServer())
      .post("/jobs/run")
      .set("Authorization", `Bearer ${salesToken}`);

    expect(response.status).toBe(403);
  });
});
