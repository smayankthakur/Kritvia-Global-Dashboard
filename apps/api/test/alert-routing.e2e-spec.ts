import { BadRequestException, INestApplication, ValidationError, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { json, urlencoded } from "express";
import helmet from "helmet";
import request from "supertest";
import { AlertRoutingService } from "../src/alerts/alert-routing.service";
import { AlertingService } from "../src/alerts/alerting.service";
import { AppModule } from "../src/app.module";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";
import { requestIdMiddleware } from "../src/common/middleware/request-id.middleware";
import { requestLoggingMiddleware } from "../src/common/middleware/request-logging.middleware";
import { encryptAppConfig } from "../src/marketplace/app-config-crypto.util";
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

describe("Alert routing channels", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let alertingService: AlertingService;
  let alertRoutingService: AlertRoutingService;
  let adminToken = "";
  let enterprisePlanId = "";

  beforeAll(async () => {
    process.env.JOBS_ENABLED = "false";
    process.env.APP_CONFIG_ENCRYPTION_KEY =
      process.env.APP_CONFIG_ENCRYPTION_KEY ??
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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
    alertRoutingService = app.get(AlertRoutingService);
    adminToken = await login(app, "admina@test.kritviya.local");

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

    await prisma.alertDelivery.deleteMany({ where: { orgId: ORG_A } });
    await prisma.alertChannel.deleteMany({ where: { orgId: ORG_A } });
    await prisma.alertEvent.deleteMany({ where: { orgId: ORG_A } });
    await prisma.alertRule.deleteMany({ where: { orgId: ORG_A } });
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it("creates alert channel with encrypted config", async () => {
    const response = await request(app.getHttpServer())
      .post("/org/alert-channels")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        type: "WEBHOOK",
        name: "Ops webhook",
        minSeverity: "HIGH",
        config: {
          url: "https://example.com/alerts",
          secret: "shared-secret"
        }
      });

    expect(response.status).toBe(201);
    expect(response.body.hasConfig).toBe(true);

    const stored = await prisma.alertChannel.findUnique({ where: { id: response.body.id } });
    expect(stored?.configEncrypted).toBeTruthy();
    expect(stored?.configEncrypted).not.toContain("example.com");
  });

  it("creates delivery for eligible channel when alert is triggered", async () => {
    const channel = await prisma.alertChannel.create({
      data: {
        orgId: ORG_A,
        type: "WEBHOOK",
        name: "Webhook channel",
        minSeverity: "HIGH",
        configEncrypted: ""
      }
    });

    await prisma.alertChannel.update({
      where: { id: channel.id },
      data: {
        configEncrypted: encryptAppConfig({
          url: "https://example.com/alerts"
        })
      }
    });

    await prisma.alertRule.create({
      data: {
        orgId: ORG_A,
        type: "JOB_FAILURE_SPIKE",
        isEnabled: true,
        thresholdCount: 1,
        windowMinutes: 10,
        severity: "HIGH"
      }
    });

    jest.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, status: 200 } as Response);

    await alertingService.recordFailure("JOB_FAILURE_SPIKE", ORG_A, {
      queue: "ai",
      reason: "synthetic"
    });

    const delivery = await prisma.alertDelivery.findFirst({
      where: {
        orgId: ORG_A,
        channelId: channel.id
      }
    });

    expect(delivery).not.toBeNull();
    expect(delivery?.success).toBe(true);
  });

  it("dedupes same alert event delivery per channel", async () => {
    const channel = await prisma.alertChannel.create({
      data: {
        orgId: ORG_A,
        type: "WEBHOOK",
        name: "Webhook channel",
        minSeverity: "HIGH",
        configEncrypted: encryptAppConfig({
          url: "https://example.com/alerts"
        })
      }
    });

    const event = await prisma.alertEvent.create({
      data: {
        orgId: ORG_A,
        type: "JOB_FAILURE_SPIKE",
        severity: "HIGH",
        title: "Test",
        details: { a: 1 }
      }
    });

    jest.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, status: 200 } as Response);

    await alertRoutingService.processDeliveryJob({
      orgId: ORG_A,
      alertEventId: event.id,
      channelId: channel.id
    });
    await alertRoutingService.processDeliveryJob({
      orgId: ORG_A,
      alertEventId: event.id,
      channelId: channel.id
    });

    const count = await prisma.alertDelivery.count({
      where: {
        orgId: ORG_A,
        alertEventId: event.id,
        channelId: channel.id
      }
    });

    expect(count).toBe(1);
  });

  it("test endpoint sends a fake alert and records delivery", async () => {
    const channel = await prisma.alertChannel.create({
      data: {
        orgId: ORG_A,
        type: "WEBHOOK",
        name: "Webhook channel",
        minSeverity: "HIGH",
        configEncrypted: encryptAppConfig({
          url: "https://example.com/alerts"
        })
      }
    });

    jest.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, status: 200 } as Response);

    const response = await request(app.getHttpServer())
      .post(`/org/alert-channels/${channel.id}/test`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ severity: "HIGH" });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.delivery).toBeTruthy();
  });

  it("slack delivery fails clearly when slack app is not connected", async () => {
    const channel = await prisma.alertChannel.create({
      data: {
        orgId: ORG_A,
        type: "SLACK",
        name: "Slack channel",
        minSeverity: "HIGH",
        configEncrypted: encryptAppConfig({
          channel: "#ops-alerts"
        })
      }
    });

    const event = await prisma.alertEvent.create({
      data: {
        orgId: ORG_A,
        type: "JOB_FAILURE_SPIKE",
        severity: "HIGH",
        title: "Test",
        details: { a: 1 }
      }
    });

    await alertRoutingService.processDeliveryJob({
      orgId: ORG_A,
      alertEventId: event.id,
      channelId: channel.id
    });

    const delivery = await prisma.alertDelivery.findFirst({
      where: {
        orgId: ORG_A,
        alertEventId: event.id,
        channelId: channel.id
      },
      orderBy: { createdAt: "desc" }
    });

    expect(delivery?.success).toBe(false);
    expect(delivery?.error).toContain("SLACK_NOT_CONNECTED");
  });
});
