import { BadRequestException, INestApplication, ValidationError, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { json, urlencoded } from "express";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { AlertingService } from "../src/alerts/alerting.service";
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

describe("Alerts and DLQ hardening", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let alertingService: AlertingService;
  let adminToken = "";
  let opsToken = "";
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
    alertingService = app.get(AlertingService);
    adminToken = await login(app, "admina@test.kritviya.local");
    opsToken = await login(app, "opsa@test.kritviya.local");

    const enterprisePlan = await prisma.plan.findUnique({ where: { key: "enterprise" }, select: { id: true } });
    if (!enterprisePlan) {
      throw new Error("Enterprise plan missing");
    }
    enterprisePlanId = enterprisePlan.id;
  });

  beforeEach(async () => {
    await prisma.subscription.upsert({
      where: { orgId: ORG_A },
      update: { planId: enterprisePlanId, status: "ACTIVE" },
      create: { orgId: ORG_A, planId: enterprisePlanId, status: "ACTIVE" }
    });

    await prisma.alertEvent.deleteMany({ where: { orgId: ORG_A } });
    await prisma.alertRule.deleteMany({ where: { orgId: ORG_A } });
    await prisma.failedJob.deleteMany({ where: { orgId: ORG_A } });
  });

  afterAll(async () => {
    await app.close();
  });

  it("creates an AlertEvent when failure threshold is crossed", async () => {
    await prisma.alertRule.create({
      data: {
        orgId: ORG_A,
        type: "JOB_FAILURE_SPIKE",
        thresholdCount: 2,
        windowMinutes: 10,
        severity: "HIGH",
        isEnabled: true
      }
    });

    await alertingService.recordFailure("JOB_FAILURE_SPIKE", ORG_A, {
      queue: "ai",
      jobName: "compute-insights",
      jobId: "job-1",
      reason: "boom"
    });

    await alertingService.recordFailure("JOB_FAILURE_SPIKE", ORG_A, {
      queue: "ai",
      jobName: "compute-insights",
      jobId: "job-2",
      reason: "boom"
    });

    const alert = await prisma.alertEvent.findFirst({
      where: { orgId: ORG_A, type: "JOB_FAILURE_SPIKE" },
      orderBy: { createdAt: "desc" }
    });

    expect(alert).not.toBeNull();
    expect(alert?.severity).toBe("HIGH");
  });

  it("webhook failure spike auto-disables endpoint", async () => {
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        orgId: ORG_A,
        url: `https://example.com/${Date.now()}`,
        secret: "test-secret",
        events: ["deal.updated"],
        isActive: true
      }
    });

    await prisma.alertRule.create({
      data: {
        orgId: ORG_A,
        type: "WEBHOOK_FAILURE_SPIKE",
        thresholdCount: 1,
        windowMinutes: 10,
        severity: "HIGH",
        isEnabled: true,
        autoMitigation: { action: "DISABLE_WEBHOOK" }
      }
    });

    await alertingService.recordFailure("WEBHOOK_FAILURE_SPIKE", ORG_A, {
      endpointId: endpoint.id,
      reason: "delivery failed"
    });

    const refreshed = await prisma.webhookEndpoint.findUnique({ where: { id: endpoint.id } });
    expect(refreshed?.isActive).toBe(false);
  });

  it("acknowledges alert event", async () => {
    const created = await prisma.alertEvent.create({
      data: {
        orgId: ORG_A,
        type: "JOB_FAILURE_SPIKE",
        severity: "HIGH",
        title: "Job failures spiking",
        details: { observedCount: 10 }
      }
    });

    const response = await request(app.getHttpServer())
      .post(`/org/alerts/${created.id}/acknowledge`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(response.status).toBe(201);
    expect(response.body.isAcknowledged).toBe(true);

    const persisted = await prisma.alertEvent.findUnique({ where: { id: created.id } });
    expect(persisted?.isAcknowledged).toBe(true);
    expect(persisted?.acknowledgedAt).not.toBeNull();
  });

  it("enforces RBAC on alert endpoints", async () => {
    const response = await request(app.getHttpServer())
      .get("/org/alerts")
      .set("Authorization", `Bearer ${opsToken}`);

    expect(response.status).toBe(403);
  });

  it("stores a failed job record in the DLQ table", async () => {
    const failed = await prisma.failedJob.create({
      data: {
        orgId: ORG_A,
        queue: "ai",
        jobName: "compute-insights",
        jobId: randomUUID(),
        error: "synthetic test failure",
        attemptsMade: 1,
        payloadHash: randomUUID().replace(/-/g, "")
      }
    });

    const persisted = await prisma.failedJob.findUnique({ where: { id: failed.id } });
    expect(persisted).not.toBeNull();
    expect(persisted?.queue).toBe("ai");
  });
});
