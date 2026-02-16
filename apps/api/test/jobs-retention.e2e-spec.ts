import { BadRequestException, INestApplication, ValidationError, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ActivityEntityType } from "@prisma/client";
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
const ORG_B = "20000000-0000-0000-0000-000000000001";

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

describe("Retention jobs", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAToken = "";
  let salesAToken = "";
  let adminAUserId = "";
  let starterPlanId = "";
  let enterprisePlanId = "";

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
    adminAToken = await login(app, "admina@test.kritviya.local");
    salesAToken = await login(app, "salesa@test.kritviya.local");

    const adminA = await prisma.user.findUnique({
      where: { email: "admina@test.kritviya.local" },
      select: { id: true }
    });
    if (!adminA) {
      throw new Error("Missing admin A user");
    }
    adminAUserId = adminA.id;

    const plans = await prisma.plan.findMany({
      where: { key: { in: ["starter", "enterprise"] } },
      select: { key: true, id: true }
    });
    starterPlanId = plans.find((plan) => plan.key === "starter")?.id ?? "";
    enterprisePlanId = plans.find((plan) => plan.key === "enterprise")?.id ?? "";
    if (!starterPlanId || !enterprisePlanId) {
      throw new Error("Required plans missing");
    }
  });

  beforeEach(async () => {
    await prisma.subscription.upsert({
      where: { orgId: ORG_A },
      update: { planId: enterprisePlanId, status: "ACTIVE" },
      create: { orgId: ORG_A, planId: enterprisePlanId, status: "ACTIVE" }
    });
    await prisma.subscription.upsert({
      where: { orgId: ORG_B },
      update: { planId: starterPlanId, status: "ACTIVE" },
      create: { orgId: ORG_B, planId: starterPlanId, status: "ACTIVE" }
    });
    await prisma.policy.upsert({
      where: { orgId: ORG_A },
      update: { auditRetentionDays: 30, securityEventRetentionDays: 30 },
      create: {
        orgId: ORG_A,
        lockInvoiceOnSent: true,
        overdueAfterDays: 0,
        defaultWorkDueDays: 3,
        staleDealAfterDays: 7,
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
        auditRetentionDays: 30,
        securityEventRetentionDays: 30
      }
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("policy validation rejects auditRetentionDays below minimum", async () => {
    const policy = await request(app.getHttpServer())
      .get("/settings/policies")
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(policy.status).toBe(200);

    const response = await request(app.getHttpServer())
      .put("/settings/policies")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({
        ...policy.body,
        auditRetentionDays: 10
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("deletes only rows older than cutoff and skips non-enterprise orgs", async () => {
    const oldLog = await prisma.activityLog.create({
      data: {
        orgId: ORG_A,
        actorUserId: adminAUserId,
        entityType: ActivityEntityType.USER,
        entityId: adminAUserId,
        action: "RETENTION_OLD_LOG"
      }
    });
    const recentLog = await prisma.activityLog.create({
      data: {
        orgId: ORG_A,
        actorUserId: adminAUserId,
        entityType: ActivityEntityType.USER,
        entityId: adminAUserId,
        action: "RETENTION_RECENT_LOG"
      }
    });
    const oldEvent = await prisma.securityEvent.create({
      data: {
        orgId: ORG_A,
        type: "RETENTION_OLD_EVENT",
        severity: "LOW",
        description: "Old security event",
        userId: adminAUserId
      }
    });
    const recentEvent = await prisma.securityEvent.create({
      data: {
        orgId: ORG_A,
        type: "RETENTION_RECENT_EVENT",
        severity: "LOW",
        description: "Recent security event",
        userId: adminAUserId
      }
    });

    await prisma.$executeRawUnsafe(
      `UPDATE activity_logs SET created_at = NOW() - INTERVAL '40 days' WHERE id = '${oldLog.id}'`
    );
    await prisma.$executeRawUnsafe(
      `UPDATE security_events SET created_at = NOW() - INTERVAL '40 days' WHERE id = '${oldEvent.id}'`
    );

    const response = await request(app.getHttpServer())
      .post("/jobs/retention/run")
      .set("Authorization", `Bearer ${adminAToken}`);

    expect(response.status).toBe(201);
    expect(response.body.processedOrgs).toBeGreaterThanOrEqual(1);
    expect(response.body.skippedOrgs).toBeGreaterThanOrEqual(1);
    expect(response.body.logsDeleted).toBeGreaterThanOrEqual(1);
    expect(response.body.eventsDeleted).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(response.body.perOrg)).toBe(true);

    const oldLogRow = await prisma.activityLog.findUnique({ where: { id: oldLog.id } });
    const recentLogRow = await prisma.activityLog.findUnique({ where: { id: recentLog.id } });
    const oldEventRow = await prisma.securityEvent.findUnique({ where: { id: oldEvent.id } });
    const recentEventRow = await prisma.securityEvent.findUnique({
      where: { id: recentEvent.id }
    });

    expect(oldLogRow).toBeNull();
    expect(recentLogRow).not.toBeNull();
    expect(oldEventRow).toBeNull();
    expect(recentEventRow).not.toBeNull();
  });

  it("blocks non-admin caller", async () => {
    const response = await request(app.getHttpServer())
      .post("/jobs/retention/run")
      .set("Authorization", `Bearer ${salesAToken}`);

    expect(response.status).toBe(403);
  });
});
