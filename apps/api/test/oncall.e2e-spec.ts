import { BadRequestException, INestApplication, ValidationError, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { json, urlencoded } from "express";
import helmet from "helmet";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { AlertsService } from "../src/alerts/alerts.service";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";
import { requestIdMiddleware } from "../src/common/middleware/request-id.middleware";
import { requestLoggingMiddleware } from "../src/common/middleware/request-logging.middleware";
import { OnCallResolver } from "../src/oncall/oncall.resolver";
import { PrismaService } from "../src/prisma/prisma.service";
import { encryptAppConfig } from "../src/marketplace/app-config-crypto.util";

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

describe("On-call rotations", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let onCallResolver: OnCallResolver;
  let alertsService: AlertsService;
  let opsToken = "";
  let enterprisePlanId = "";

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
    onCallResolver = app.get(OnCallResolver);
    alertsService = app.get(AlertsService);

    await login(app, "admina@test.kritviya.local");
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

    await prisma.alertEscalation.deleteMany({ where: { orgId: ORG_A } });
    await prisma.alertEvent.deleteMany({ where: { orgId: ORG_A } });
    await prisma.alertChannel.deleteMany({ where: { orgId: ORG_A } });
    await prisma.onCallScheduleCalendar.deleteMany({ where: { schedule: { orgId: ORG_A } } });
    await prisma.holidayEntry.deleteMany({ where: { calendar: { orgId: ORG_A } } });
    await prisma.holidayCalendar.deleteMany({ where: { orgId: ORG_A } });
    await prisma.onCallOverride.deleteMany({ where: { schedule: { orgId: ORG_A } } });
    await prisma.onCallRotationMember.deleteMany({ where: { schedule: { orgId: ORG_A } } });
    await prisma.onCallSchedule.deleteMany({ where: { orgId: ORG_A } });
  });

  afterAll(async () => {
    await app.close();
  });

  it("resolver returns correct member for weekly slot", async () => {
    const [admin, ceo] = await Promise.all([
      prisma.user.findFirstOrThrow({ where: { email: "admina@test.kritviya.local" }, select: { id: true } }),
      prisma.user.findFirstOrThrow({ where: { email: "ceoa@test.kritviya.local" }, select: { id: true } })
    ]);

    const schedule = await prisma.onCallSchedule.create({
      data: {
        orgId: ORG_A,
        name: "Weekly",
        timezone: "UTC",
        handoffInterval: "WEEKLY",
        handoffHour: 10,
        startAt: new Date("2026-01-01T10:00:00.000Z")
      }
    });

    await prisma.onCallRotationMember.createMany({
      data: [
        { scheduleId: schedule.id, userId: admin.id, tier: "PRIMARY", order: 1 },
        { scheduleId: schedule.id, userId: ceo.id, tier: "PRIMARY", order: 2 }
      ]
    });

    const resolvedWeek1 = await onCallResolver.resolveNow(ORG_A, new Date("2026-01-02T11:00:00.000Z"));
    const resolvedWeek2 = await onCallResolver.resolveNow(ORG_A, new Date("2026-01-10T11:00:00.000Z"));

    expect(resolvedWeek1.primaryUserId).toBe(admin.id);
    expect(resolvedWeek2.primaryUserId).toBe(ceo.id);
  });

  it("override replaces tier user during window", async () => {
    const [admin, ceo, ops] = await Promise.all([
      prisma.user.findFirstOrThrow({ where: { email: "admina@test.kritviya.local" }, select: { id: true } }),
      prisma.user.findFirstOrThrow({ where: { email: "ceoa@test.kritviya.local" }, select: { id: true } }),
      prisma.user.findFirstOrThrow({ where: { email: "opsa@test.kritviya.local" }, select: { id: true } })
    ]);

    const schedule = await prisma.onCallSchedule.create({
      data: {
        orgId: ORG_A,
        name: "Override",
        timezone: "UTC",
        handoffInterval: "WEEKLY",
        handoffHour: 10,
        startAt: new Date("2026-01-01T10:00:00.000Z")
      }
    });

    await prisma.onCallRotationMember.createMany({
      data: [
        { scheduleId: schedule.id, userId: admin.id, tier: "PRIMARY", order: 1 },
        { scheduleId: schedule.id, userId: ceo.id, tier: "SECONDARY", order: 1 }
      ]
    });

    await prisma.onCallOverride.create({
      data: {
        scheduleId: schedule.id,
        tier: "PRIMARY",
        fromUserId: admin.id,
        toUserId: ops.id,
        startAt: new Date("2026-01-01T00:00:00.000Z"),
        endAt: new Date("2026-01-31T23:59:59.000Z"),
        reason: "PTO"
      }
    });

    const resolved = await onCallResolver.resolveNow(ORG_A, new Date("2026-01-15T11:00:00.000Z"));
    expect(resolved.primaryUserId).toBe(ops.id);
  });

  it("holiday entry range makes schedule inactive and falls back", async () => {
    const [admin, ceo] = await Promise.all([
      prisma.user.findFirstOrThrow({ where: { email: "admina@test.kritviya.local" }, select: { id: true } }),
      prisma.user.findFirstOrThrow({ where: { email: "ceoa@test.kritviya.local" }, select: { id: true } })
    ]);

    const fallbackSchedule = await prisma.onCallSchedule.create({
      data: {
        orgId: ORG_A,
        name: "Global fallback",
        timezone: "UTC",
        handoffInterval: "DAILY",
        handoffHour: 0,
        startAt: new Date("2026-01-01T00:00:00.000Z")
      }
    });

    const localSchedule = await prisma.onCallSchedule.create({
      data: {
        orgId: ORG_A,
        name: "Local schedule",
        timezone: "UTC",
        handoffInterval: "DAILY",
        handoffHour: 0,
        startAt: new Date("2026-01-01T00:00:00.000Z"),
        fallbackScheduleId: fallbackSchedule.id
      }
    });

    const holidayCalendar = await prisma.holidayCalendar.create({
      data: {
        orgId: ORG_A,
        name: "India holidays",
        timezone: "UTC"
      }
    });

    await prisma.holidayEntry.create({
      data: {
        calendarId: holidayCalendar.id,
        startDate: new Date("2026-01-15T00:00:00.000Z"),
        endDate: new Date("2026-01-15T00:00:00.000Z"),
        title: "Regional holiday"
      }
    });

    await prisma.onCallScheduleCalendar.create({
      data: { scheduleId: localSchedule.id, calendarId: holidayCalendar.id }
    });

    await prisma.onCallRotationMember.createMany({
      data: [
        { scheduleId: localSchedule.id, userId: admin.id, tier: "PRIMARY", order: 1 },
        { scheduleId: fallbackSchedule.id, userId: ceo.id, tier: "PRIMARY", order: 1 }
      ]
    });

    const resolved = await onCallResolver.resolveNow(ORG_A, new Date("2026-01-15T10:00:00.000Z"));
    expect(resolved.primaryUserId).toBe(ceo.id);
    expect(resolved.activeScheduleId).toBe(fallbackSchedule.id);
  });

  it("coverage window off-hours skips local schedule and uses fallback schedule", async () => {
    const [admin, ceo] = await Promise.all([
      prisma.user.findFirstOrThrow({ where: { email: "admina@test.kritviya.local" }, select: { id: true } }),
      prisma.user.findFirstOrThrow({ where: { email: "ceoa@test.kritviya.local" }, select: { id: true } })
    ]);

    const fallbackSchedule = await prisma.onCallSchedule.create({
      data: {
        orgId: ORG_A,
        name: "Follow-the-sun fallback",
        timezone: "UTC",
        handoffInterval: "DAILY",
        handoffHour: 0,
        startAt: new Date("2026-01-01T00:00:00.000Z")
      }
    });

    const localSchedule = await prisma.onCallSchedule.create({
      data: {
        orgId: ORG_A,
        name: "Business-hours local",
        timezone: "UTC",
        handoffInterval: "DAILY",
        handoffHour: 0,
        startAt: new Date("2026-01-01T00:00:00.000Z"),
        coverageEnabled: true,
        coverageDays: ["MON", "TUE", "WED", "THU", "FRI"],
        coverageStart: "10:00",
        coverageEnd: "19:00",
        fallbackScheduleId: fallbackSchedule.id
      }
    });

    await prisma.onCallRotationMember.createMany({
      data: [
        { scheduleId: localSchedule.id, userId: admin.id, tier: "PRIMARY", order: 1 },
        { scheduleId: fallbackSchedule.id, userId: ceo.id, tier: "PRIMARY", order: 1 }
      ]
    });

    const resolved = await onCallResolver.resolveNow(ORG_A, new Date("2026-01-05T21:00:00.000Z"));
    expect(resolved.primaryUserId).toBe(ceo.id);
    expect(resolved.activeScheduleId).toBe(fallbackSchedule.id);
    expect(resolved.inCoverageWindow).toBe(true);
  });

  it("escalation routes ONCALL_PRIMARY_EMAIL through email delivery", async () => {
    const admin = await prisma.user.findFirstOrThrow({
      where: { email: "admina@test.kritviya.local" },
      select: { id: true, email: true }
    });

    const schedule = await prisma.onCallSchedule.create({
      data: {
        orgId: ORG_A,
        name: "Escalation route",
        timezone: "UTC",
        handoffInterval: "DAILY",
        handoffHour: 0,
        startAt: new Date("2026-01-01T00:00:00.000Z")
      }
    });

    await prisma.onCallRotationMember.create({
      data: {
        scheduleId: schedule.id,
        userId: admin.id,
        tier: "PRIMARY",
        order: 1
      }
    });

    await prisma.alertChannel.create({
      data: {
        orgId: ORG_A,
        type: "EMAIL",
        name: "Escalation email",
        minSeverity: "HIGH",
        configEncrypted: encryptAppConfig({ to: ["fallback@test.kritviya.local"] })
      }
    });

    await prisma.escalationPolicy.create({
      data: {
        orgId: ORG_A,
        name: "Escalation policy",
        timezone: "UTC",
        slaCritical: 10,
        slaHigh: 30,
        slaMedium: 180,
        slaLow: 1440,
        steps: [{ afterMinutes: 10, routeTo: ["ONCALL_PRIMARY_EMAIL"], minSeverity: "CRITICAL" }]
      }
    });

    await prisma.alertEvent.create({
      data: {
        orgId: ORG_A,
        type: "JOB_FAILURE_SPIKE",
        severity: "CRITICAL",
        title: "Critical alert",
        details: { source: "test" },
        createdAt: new Date(Date.now() - 20 * 60_000)
      }
    });

    const fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, status: 200 } as Response);
    const result = await alertsService.runEscalationScanForOrg(ORG_A, new Date());

    expect(result.escalated).toBeGreaterThanOrEqual(1);
    expect(fetchSpy).toHaveBeenCalled();
    const callBody = String(fetchSpy.mock.calls[0]?.[1] && (fetchSpy.mock.calls[0]?.[1] as RequestInit).body);
    expect(callBody).toContain(admin.email);
    fetchSpy.mockRestore();
  });

  it("escalation routes ONCALL_PRIMARY_GLOBAL through fallback schedule", async () => {
    const [admin, ceo] = await Promise.all([
      prisma.user.findFirstOrThrow({
        where: { email: "admina@test.kritviya.local" },
        select: { id: true, email: true }
      }),
      prisma.user.findFirstOrThrow({
        where: { email: "ceoa@test.kritviya.local" },
        select: { id: true, email: true }
      })
    ]);

    const globalSchedule = await prisma.onCallSchedule.create({
      data: {
        orgId: ORG_A,
        name: "Global schedule",
        timezone: "UTC",
        handoffInterval: "DAILY",
        handoffHour: 0,
        startAt: new Date("2026-01-01T00:00:00.000Z")
      }
    });

    const localSchedule = await prisma.onCallSchedule.create({
      data: {
        orgId: ORG_A,
        name: "Local schedule",
        timezone: "UTC",
        handoffInterval: "DAILY",
        handoffHour: 0,
        startAt: new Date("2026-01-01T00:00:00.000Z"),
        coverageEnabled: true,
        coverageDays: ["MON", "TUE", "WED", "THU", "FRI"],
        coverageStart: "10:00",
        coverageEnd: "18:00",
        fallbackScheduleId: globalSchedule.id
      }
    });

    await prisma.onCallRotationMember.createMany({
      data: [
        { scheduleId: localSchedule.id, userId: admin.id, tier: "PRIMARY", order: 1 },
        { scheduleId: globalSchedule.id, userId: ceo.id, tier: "PRIMARY", order: 1 }
      ]
    });

    await prisma.alertChannel.create({
      data: {
        orgId: ORG_A,
        type: "EMAIL",
        name: "Escalation email",
        minSeverity: "HIGH",
        configEncrypted: encryptAppConfig({ to: ["fallback@test.kritviya.local"] })
      }
    });

    await prisma.escalationPolicy.create({
      data: {
        orgId: ORG_A,
        name: "Escalation policy",
        timezone: "UTC",
        slaCritical: 10,
        slaHigh: 30,
        slaMedium: 180,
        slaLow: 1440,
        steps: [{ afterMinutes: 10, routeTo: ["ONCALL_PRIMARY_GLOBAL"], minSeverity: "CRITICAL" }]
      }
    });

    await prisma.alertEvent.create({
      data: {
        orgId: ORG_A,
        type: "JOB_FAILURE_SPIKE",
        severity: "CRITICAL",
        title: "Critical alert",
        details: { source: "test" },
        createdAt: new Date(Date.now() - 20 * 60_000)
      }
    });

    const fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, status: 200 } as Response);
    await alertsService.runEscalationScanForOrg(ORG_A, new Date("2026-01-05T21:10:00.000Z"));
    expect(fetchSpy).toHaveBeenCalled();
    const callBody = String(fetchSpy.mock.calls[0]?.[1] && (fetchSpy.mock.calls[0]?.[1] as RequestInit).body);
    expect(callBody).toContain(ceo.email);
    expect(callBody).not.toContain(admin.email);
    fetchSpy.mockRestore();
  });

  it("enforces RBAC for oncall endpoints", async () => {
    const response = await request(app.getHttpServer())
      .get("/org/oncall/schedules")
      .set("Authorization", `Bearer ${opsToken}`);

    expect(response.status).toBe(403);
  });

  it("enforces RBAC for holiday endpoints", async () => {
    const response = await request(app.getHttpServer())
      .get("/org/holidays/calendars")
      .set("Authorization", `Bearer ${opsToken}`);

    expect(response.status).toBe(403);
  });
});
