import { BadRequestException, INestApplication, ValidationError, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { json, urlencoded } from "express";
import helmet from "helmet";
import { AppModule } from "../src/app.module";
import { AlertsService } from "../src/alerts/alerts.service";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";
import { requestIdMiddleware } from "../src/common/middleware/request-id.middleware";
import { requestLoggingMiddleware } from "../src/common/middleware/request-logging.middleware";
import { PrismaService } from "../src/prisma/prisma.service";

jest.setTimeout(60000);

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

describe("Alert escalation policy", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let alertsService: AlertsService;

  beforeAll(async () => {
    process.env.JOBS_ENABLED = "false";

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
    alertsService = app.get(AlertsService);
  });

  beforeEach(async () => {
    await prisma.alertEscalation.deleteMany({ where: { orgId: ORG_A } });
    await prisma.alertEvent.deleteMany({ where: { orgId: ORG_A } });
    await prisma.escalationPolicy.deleteMany({ where: { orgId: ORG_A } });
  });

  afterAll(async () => {
    await app.close();
  });

  it("escalates CRITICAL alert after 10 minutes when unacknowledged", async () => {
    const now = new Date();
    const createdAt = new Date(now.getTime() - 11 * 60_000);

    const event = await prisma.alertEvent.create({
      data: {
        orgId: ORG_A,
        type: "JOB_FAILURE_SPIKE",
        severity: "CRITICAL",
        title: "Critical job failures",
        details: { source: "test" },
        createdAt
      }
    });

    const result = await alertsService.runEscalationScanForOrg(ORG_A, now);

    expect(result.escalated).toBeGreaterThanOrEqual(1);
    const escalation = await prisma.alertEscalation.findFirst({
      where: { orgId: ORG_A, alertEventId: event.id, stepNumber: 1 }
    });
    expect(escalation).not.toBeNull();
    expect(escalation?.suppressed).toBe(false);
  });

  it("does not escalate when alert is already acknowledged", async () => {
    const now = new Date();
    const createdAt = new Date(now.getTime() - 30 * 60_000);

    await prisma.alertEvent.create({
      data: {
        orgId: ORG_A,
        type: "WEBHOOK_FAILURE_SPIKE",
        severity: "CRITICAL",
        title: "Webhook failures",
        details: { source: "test" },
        createdAt,
        isAcknowledged: true,
        acknowledgedAt: now
      }
    });

    const result = await alertsService.runEscalationScanForOrg(ORG_A, now);
    expect(result.totalProcessed).toBe(0);

    const count = await prisma.alertEscalation.count({ where: { orgId: ORG_A } });
    expect(count).toBe(0);
  });

  it("suppresses escalation during quiet hours", async () => {
    const now = new Date("2026-02-18T12:00:00.000Z");
    const createdAt = new Date(now.getTime() - 20 * 60_000);

    await prisma.escalationPolicy.create({
      data: {
        orgId: ORG_A,
        name: "Quiet policy",
        timezone: "UTC",
        quietHoursEnabled: true,
        quietHoursStart: "00:00",
        quietHoursEnd: "23:59",
        slaCritical: 10,
        slaHigh: 30,
        slaMedium: 180,
        slaLow: 1440,
        steps: [{ afterMinutes: 10, routeTo: ["SLACK"], minSeverity: "CRITICAL" }]
      }
    });

    const event = await prisma.alertEvent.create({
      data: {
        orgId: ORG_A,
        type: "JOB_FAILURE_SPIKE",
        severity: "CRITICAL",
        title: "Quiet-hours test",
        details: { source: "test" },
        createdAt
      }
    });

    const result = await alertsService.runEscalationScanForOrg(ORG_A, now);

    expect(result.suppressed).toBeGreaterThanOrEqual(1);
    const escalation = await prisma.alertEscalation.findFirst({
      where: { orgId: ORG_A, alertEventId: event.id, stepNumber: 1 }
    });
    expect(escalation?.suppressed).toBe(true);
    expect(escalation?.reason).toBe("quiet-hours");
  });

  it("applies cooldown and avoids repeated escalation within 10 minutes", async () => {
    const now = new Date("2026-02-18T12:00:00.000Z");
    const createdAt = new Date(now.getTime() - 30 * 60_000);

    await prisma.escalationPolicy.create({
      data: {
        orgId: ORG_A,
        name: "Cooldown policy",
        timezone: "UTC",
        quietHoursEnabled: false,
        slaCritical: 10,
        slaHigh: 30,
        slaMedium: 180,
        slaLow: 1440,
        steps: [{ afterMinutes: 10, routeTo: ["EMAIL"], minSeverity: "CRITICAL" }]
      }
    });

    await prisma.alertEvent.create({
      data: {
        orgId: ORG_A,
        type: "JOB_FAILURE_SPIKE",
        severity: "CRITICAL",
        title: "Cooldown alert",
        details: { source: "test" },
        createdAt
      }
    });

    const first = await alertsService.runEscalationScanForOrg(ORG_A, now);
    expect(first.escalated).toBe(1);

    const second = await alertsService.runEscalationScanForOrg(
      ORG_A,
      new Date(now.getTime() + 3 * 60_000)
    );

    expect(second.escalated).toBe(0);
    const count = await prisma.alertEscalation.count({ where: { orgId: ORG_A } });
    expect(count).toBe(1);
  });
});
