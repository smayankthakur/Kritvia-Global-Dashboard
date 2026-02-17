import { BadRequestException, INestApplication, ValidationError, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { json, urlencoded } from "express";
import helmet from "helmet";
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

describe("Incidents", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let alertingService: AlertingService;
  let adminToken = "";
  let opsToken = "";
  let enterprisePlanId = "";

  beforeAll(async () => {
    process.env.JOBS_ENABLED = "false";
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

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

    await prisma.incidentTimeline.deleteMany({ where: { incident: { orgId: ORG_A } } });
    await prisma.incidentParticipant.deleteMany({ where: { incident: { orgId: ORG_A } } });
    await prisma.incidentPostmortem.deleteMany({ where: { orgId: ORG_A } });
    await prisma.incident.deleteMany({ where: { orgId: ORG_A } });
    await prisma.alertEvent.deleteMany({ where: { orgId: ORG_A } });
    await prisma.alertRule.deleteMany({ where: { orgId: ORG_A } });
  });

  afterAll(async () => {
    await app.close();
  });

  it("auto-creates incident for critical alert event", async () => {
    await prisma.alertRule.create({
      data: {
        orgId: ORG_A,
        type: "JOB_FAILURE_SPIKE",
        thresholdCount: 1,
        windowMinutes: 10,
        severity: "CRITICAL",
        isEnabled: true,
        autoCreateIncident: false
      }
    });

    await alertingService.recordFailure("JOB_FAILURE_SPIKE", ORG_A, { reason: "test failure" });

    const incident = await prisma.incident.findFirst({
      where: { orgId: ORG_A },
      include: { timeline: true }
    });

    expect(incident).not.toBeNull();
    expect(incident?.severity).toBe("CRITICAL");
    expect(incident?.timeline.some((entry) => entry.type === "CREATED")).toBe(true);
  });

  it("acknowledge sets owner and writes timeline entry", async () => {
    const incident = await prisma.incident.create({
      data: {
        orgId: ORG_A,
        title: "Ack me",
        severity: "HIGH"
      }
    });

    const response = await request(app.getHttpServer())
      .post(`/org/incidents/${incident.id}/acknowledge`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(response.status).toBe(201);
    expect(response.body.ownerUserId).toBeTruthy();
    expect(response.body.status).toBe("ACKNOWLEDGED");

    const timeline = await prisma.incidentTimeline.findMany({ where: { incidentId: incident.id } });
    expect(timeline.some((entry) => entry.type === "ACKNOWLEDGED")).toBe(true);
  });

  it("resolve computes mttr and updates status", async () => {
    const created = await prisma.incident.create({
      data: {
        orgId: ORG_A,
        title: "Resolve me",
        severity: "HIGH",
        status: "ACKNOWLEDGED",
        ownerUserId: (await prisma.user.findFirstOrThrow({ where: { email: "admina@test.kritviya.local" }, select: { id: true } })).id,
        createdAt: new Date(Date.now() - 45 * 60_000)
      }
    });

    const response = await request(app.getHttpServer())
      .post(`/org/incidents/${created.id}/resolve`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(response.status).toBe(201);
    expect(response.body.status).toBe("RESOLVED");
    expect(response.body.mttrMinutes).toBeGreaterThanOrEqual(40);
  });

  it("enforces unique postmortem per incident", async () => {
    const incident = await prisma.incident.create({
      data: {
        orgId: ORG_A,
        title: "Postmortem target",
        severity: "MEDIUM"
      }
    });

    const first = await request(app.getHttpServer())
      .post(`/org/incidents/${incident.id}/postmortem`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ summary: "First" });

    expect(first.status).toBe(201);

    const second = await request(app.getHttpServer())
      .post(`/org/incidents/${incident.id}/postmortem`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ summary: "Second" });

    expect(second.status).toBe(201);

    const rows = await prisma.incidentPostmortem.findMany({ where: { incidentId: incident.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toBe("Second");
  });

  it("returns incident SLA metrics", async () => {
    const now = Date.now();
    await prisma.incident.createMany({
      data: [
        {
          orgId: ORG_A,
          title: "A",
          severity: "HIGH",
          status: "RESOLVED",
          createdAt: new Date(now - 120 * 60_000),
          acknowledgedAt: new Date(now - 110 * 60_000),
          resolvedAt: new Date(now - 60 * 60_000)
        },
        {
          orgId: ORG_A,
          title: "B",
          severity: "MEDIUM",
          status: "OPEN",
          createdAt: new Date(now - 30 * 60_000)
        }
      ]
    });

    const response = await request(app.getHttpServer())
      .get("/org/incidents/metrics?range=30d")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.body.totalIncidents).toBeGreaterThanOrEqual(2);
    expect(response.body.openIncidents).toBeGreaterThanOrEqual(1);
    expect(response.body.resolvedIncidents).toBeGreaterThanOrEqual(1);
    expect(response.body.avgMTTA).toBeGreaterThan(0);
    expect(response.body.avgMTTR).toBeGreaterThan(0);
  });

  it("allows on-call primary to acknowledge", async () => {
    const opsUser = await prisma.user.findFirstOrThrow({
      where: { email: "opsa@test.kritviya.local" },
      select: { id: true }
    });

    const schedule = await prisma.onCallSchedule.create({
      data: {
        orgId: ORG_A,
        name: "Primary",
        timezone: "UTC",
        handoffInterval: "DAILY",
        handoffHour: 0
      }
    });

    await prisma.onCallRotationMember.create({
      data: {
        scheduleId: schedule.id,
        userId: opsUser.id,
        tier: "PRIMARY",
        order: 1
      }
    });

    const incident = await prisma.incident.create({
      data: { orgId: ORG_A, title: "Ops ack", severity: "HIGH" }
    });

    const response = await request(app.getHttpServer())
      .post(`/org/incidents/${incident.id}/acknowledge`)
      .set("Authorization", `Bearer ${opsToken}`);

    expect(response.status).toBe(201);
    expect(response.body.status).toBe("ACKNOWLEDGED");
  });
});
