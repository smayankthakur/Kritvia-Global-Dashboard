import { BadRequestException, INestApplication, ValidationError, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ActivityEntityType, InvoiceStatus, Prisma } from "@prisma/client";
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

describe("AI Actions", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken = "";
  let opsToken = "";
  let adminUserId = "";
  let growthPlanId = "";

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
    opsToken = await login(app, "opsa@test.kritviya.local");

    const [adminUser, growthPlan] = await prisma.$transaction([
      prisma.user.findUnique({
        where: { email: "admina@test.kritviya.local" },
        select: { id: true }
      }),
      prisma.plan.findUnique({
        where: { key: "growth" },
        select: { id: true }
      })
    ]);
    adminUserId = adminUser?.id ?? "";
    growthPlanId = growthPlan?.id ?? "";
    if (!adminUserId || !growthPlanId) {
      throw new Error("Required seed fixtures missing");
    }
  });

  beforeEach(async () => {
    await prisma.subscription.upsert({
      where: { orgId: ORG_A },
      update: { planId: growthPlanId, status: "ACTIVE" },
      create: { orgId: ORG_A, planId: growthPlanId, status: "ACTIVE" }
    });

    await prisma.aIAction.deleteMany({ where: { orgId: ORG_A } });
    await prisma.aIInsight.deleteMany({ where: { orgId: ORG_A } });
    await prisma.nudge.deleteMany({ where: { orgId: ORG_A } });
    await prisma.workItem.deleteMany({ where: { orgId: ORG_A } });
    await prisma.invoice.deleteMany({ where: { orgId: ORG_A } });
    await prisma.deal.deleteMany({ where: { orgId: ORG_A } });
    await prisma.company.deleteMany({ where: { orgId: ORG_A } });
    await prisma.activityLog.deleteMany({
      where: {
        orgId: ORG_A,
        entityType: ActivityEntityType.AI_ACTION
      }
    });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("compute-actions creates proposals without duplicates", async () => {
    await prisma.aIInsight.create({
      data: {
        orgId: ORG_A,
        type: "DEAL_STALL",
        severity: "HIGH",
        scoreImpact: 20,
        title: "Deals stalling in pipeline",
        explanation: "5 open deals are idle"
      }
    });

    const first = await request(app.getHttpServer())
      .post("/ai/compute-actions")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(first.status).toBe(201);
    expect(first.body.created).toBeGreaterThan(0);

    const second = await request(app.getHttpServer())
      .post("/ai/compute-actions")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(second.status).toBe(201);
    expect(second.body.created).toBe(0);
    expect(second.body.skipped).toBeGreaterThan(0);
  });

  it("approve changes status", async () => {
    const insight = await prisma.aIInsight.create({
      data: {
        orgId: ORG_A,
        type: "OPS_RISK",
        severity: "MEDIUM",
        scoreImpact: 12,
        title: "Ops risk",
        explanation: "Overdue work"
      }
    });
    const action = await prisma.aIAction.create({
      data: {
        orgId: ORG_A,
        insightId: insight.id,
        type: "CREATE_NUDGE",
        status: "PROPOSED",
        title: "Nudge ops",
        rationale: "Need action",
        payload: {
          targetRole: "OPS",
          message: "Overdue work items-prioritize today",
          entityType: ActivityEntityType.WORK_ITEM,
          entityId: insight.id
        } as Prisma.InputJsonValue
      }
    });

    const response = await request(app.getHttpServer())
      .post(`/ai/actions/${action.id}/approve`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(response.status).toBe(201);
    expect(response.body.status).toBe("APPROVED");
    expect(response.body.approvedByUserId).toBe(adminUserId);
  });

  it("execute CREATE_NUDGE creates nudge and undo reverts within window", async () => {
    const insight = await prisma.aIInsight.create({
      data: {
        orgId: ORG_A,
        type: "DEAL_STALL",
        severity: "HIGH",
        scoreImpact: 22,
        title: "Deal stall",
        explanation: "Deals are stale"
      }
    });
    const action = await prisma.aIAction.create({
      data: {
        orgId: ORG_A,
        insightId: insight.id,
        type: "CREATE_NUDGE",
        status: "APPROVED",
        title: "Nudge Sales",
        rationale: "Follow up",
        payload: {
          targetRole: "SALES",
          message: "Follow up on stalled deals",
          entityType: ActivityEntityType.DEAL,
          entityId: insight.id
        } as Prisma.InputJsonValue
      }
    });

    const execute = await request(app.getHttpServer())
      .post(`/ai/actions/${action.id}/execute`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(execute.status).toBe(201);
    expect(execute.body.status).toBe("EXECUTED");

    const createdNudge = await prisma.nudge.findFirst({
      where: { orgId: ORG_A, message: "Follow up on stalled deals" }
    });
    expect(createdNudge).toBeTruthy();

    const audit = await prisma.activityLog.findFirst({
      where: {
        orgId: ORG_A,
        entityType: ActivityEntityType.AI_ACTION,
        entityId: action.id,
        action: "AI_ACTION_EXECUTED"
      }
    });
    expect(audit).toBeTruthy();

    const undo = await request(app.getHttpServer())
      .post(`/ai/actions/${action.id}/undo`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(undo.status).toBe(201);
    expect(undo.body.status).toBe("CANCELED");

    const afterUndoNudge = await prisma.nudge.findUnique({
      where: { id: createdNudge?.id ?? "" }
    });
    expect(afterUndoNudge).toBeNull();
  });

  it("ops role cannot execute LOCK_INVOICE", async () => {
    const company = await prisma.company.create({
      data: {
        orgId: ORG_A,
        name: `AI Action Company ${Date.now()}`
      }
    });
    const invoice = await prisma.invoice.create({
      data: {
        orgId: ORG_A,
        companyId: company.id,
        status: InvoiceStatus.SENT,
        amount: new Prisma.Decimal(1000),
        dueDate: new Date(),
        createdByUserId: adminUserId
      }
    });
    const action = await prisma.aIAction.create({
      data: {
        orgId: ORG_A,
        type: "LOCK_INVOICE",
        status: "APPROVED",
        title: "Lock invoice",
        rationale: "Finance lock action",
        payload: {
          invoiceId: invoice.id
        } as Prisma.InputJsonValue
      }
    });

    const response = await request(app.getHttpServer())
      .post(`/ai/actions/${action.id}/execute`)
      .set("Authorization", `Bearer ${opsToken}`);
    expect(response.status).toBe(403);
  });
});
