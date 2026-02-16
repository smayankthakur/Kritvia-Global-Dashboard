import { BadRequestException, INestApplication, ValidationError, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ActivityEntityType, DealStage, InvoiceStatus, Prisma } from "@prisma/client";
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

describe("AI Insights Engine", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken = "";
  let adminUserId = "";
  let revenuePlanId = "";

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
    const adminUser = await prisma.user.findUnique({
      where: { email: "admina@test.kritviya.local" },
      select: { id: true }
    });
    adminUserId = adminUser?.id ?? "";

    const growthPlan = await prisma.plan.findUnique({
      where: { key: "growth" },
      select: { id: true }
    });
    if (!growthPlan?.id) {
      throw new Error("Growth plan not seeded");
    }
    revenuePlanId = growthPlan.id;
  });

  beforeEach(async () => {
    await prisma.subscription.upsert({
      where: { orgId: ORG_A },
      update: { status: "ACTIVE", planId: revenuePlanId },
      create: { orgId: ORG_A, status: "ACTIVE", planId: revenuePlanId }
    });

    await prisma.aIInsight.deleteMany({ where: { orgId: ORG_A } });
    await prisma.securityEvent.deleteMany({ where: { orgId: ORG_A } });
    await prisma.workItem.deleteMany({ where: { orgId: ORG_A } });
    await prisma.invoice.deleteMany({ where: { orgId: ORG_A } });
    await prisma.deal.deleteMany({ where: { orgId: ORG_A } });
    await prisma.company.deleteMany({ where: { orgId: ORG_A } });
    await prisma.orgHealthSnapshot.deleteMany({ where: { orgId: ORG_A } });
    await prisma.activityLog.deleteMany({
      where: {
        orgId: ORG_A,
        entityType: ActivityEntityType.AI_INSIGHT
      }
    });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("computes deterministic insights and returns unresolved list", async () => {
    const company = await prisma.company.create({
      data: {
        orgId: ORG_A,
        name: `AI Test Company ${Date.now()}`
      }
    });

    const staleUpdatedAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    await prisma.deal.create({
      data: {
        orgId: ORG_A,
        companyId: company.id,
        title: "Stalled pipeline deal",
        stage: DealStage.OPEN,
        valueAmount: 150000,
        updatedAt: staleUpdatedAt
      }
    });

    await prisma.invoice.create({
      data: {
        orgId: ORG_A,
        companyId: company.id,
        status: InvoiceStatus.SENT,
        amount: new Prisma.Decimal(250000),
        dueDate: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000),
        createdByUserId: adminUserId
      }
    });

    await prisma.workItem.create({
      data: {
        orgId: ORG_A,
        title: "Overdue execution item",
        status: "TODO",
        dueDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        createdByUserId: adminUserId
      }
    });

    await prisma.securityEvent.create({
      data: {
        orgId: ORG_A,
        type: "INVOICE_UNLOCK",
        severity: "CRITICAL",
        description: "Critical shield issue"
      }
    });

    await prisma.orgHealthSnapshot.createMany({
      data: [
        {
          orgId: ORG_A,
          dateKey: "2026-02-15",
          score: 85,
          breakdown: {}
        },
        {
          orgId: ORG_A,
          dateKey: "2026-02-16",
          score: 60,
          breakdown: {}
        }
      ]
    });

    const compute = await request(app.getHttpServer())
      .post("/ai/compute-insights")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(compute.status).toBe(201);
    expect(compute.body.total).toBeGreaterThanOrEqual(4);

    const list = await request(app.getHttpServer())
      .get("/ceo/insights")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    expect(list.body.some((item: { type: string }) => item.type === "DEAL_STALL")).toBe(true);
  });

  it("returns insights ordered by severity then scoreImpact", async () => {
    const now = new Date();
    const [criticalLow, criticalHigh, medium] = await prisma.$transaction([
      prisma.aIInsight.create({
        data: {
          orgId: ORG_A,
          type: "DEAL_STALL",
          severity: "CRITICAL",
          scoreImpact: 20,
          title: "Critical low score",
          explanation: "test",
          createdAt: new Date(now.getTime() - 1000)
        }
      }),
      prisma.aIInsight.create({
        data: {
          orgId: ORG_A,
          type: "OPS_RISK",
          severity: "CRITICAL",
          scoreImpact: 45,
          title: "Critical high score",
          explanation: "test",
          createdAt: new Date(now.getTime() - 2000)
        }
      }),
      prisma.aIInsight.create({
        data: {
          orgId: ORG_A,
          type: "CASHFLOW_ALERT",
          severity: "MEDIUM",
          scoreImpact: 99,
          title: "Medium score",
          explanation: "test",
          createdAt: now
        }
      })
    ]);

    const list = await request(app.getHttpServer())
      .get("/ceo/insights")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(list.status).toBe(200);
    expect(list.body[0].id).toBe(criticalHigh.id);
    expect(list.body[1].id).toBe(criticalLow.id);
    expect(list.body[2].id).toBe(medium.id);
  });

  it("resolves insight and writes AI_INSIGHT_RESOLVED audit entry", async () => {
    const insight = await prisma.aIInsight.create({
      data: {
        orgId: ORG_A,
        type: "OPS_RISK",
        severity: "HIGH",
        scoreImpact: 30,
        title: "Ops backlog",
        explanation: "Overdue work detected"
      }
    });

    const resolve = await request(app.getHttpServer())
      .post(`/ceo/insights/${insight.id}/resolve`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(resolve.status).toBe(201);
    expect(resolve.body.success).toBe(true);

    const updated = await prisma.aIInsight.findUnique({
      where: { id: insight.id },
      select: { isResolved: true, resolvedAt: true }
    });
    expect(updated?.isResolved).toBe(true);
    expect(updated?.resolvedAt).toBeTruthy();

    const audit = await prisma.activityLog.findFirst({
      where: {
        orgId: ORG_A,
        entityType: ActivityEntityType.AI_INSIGHT,
        entityId: insight.id,
        action: "AI_INSIGHT_RESOLVED"
      }
    });
    expect(audit).toBeTruthy();
  });
});
