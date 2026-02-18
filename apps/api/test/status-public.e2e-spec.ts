import { BadRequestException, INestApplication, ValidationError, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { json, urlencoded } from "express";
import helmet from "helmet";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";
import { requestIdMiddleware } from "../src/common/middleware/request-id.middleware";
import { requestLoggingMiddleware } from "../src/common/middleware/request-logging.middleware";
import { PrismaService } from "../src/prisma/prisma.service";
import { StatusService } from "../src/status/status.service";

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

describe("Public status page + incident publishing", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let statusService: StatusService;
  let adminToken = "";

  beforeAll(async () => {
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
    statusService = app.get(StatusService);
    adminToken = await login(app, "admina@test.kritviya.local");
  });

  beforeEach(async () => {
    await prisma.uptimeCheck.deleteMany({});
    await prisma.statusComponent.deleteMany({});
    await prisma.incidentTimeline.deleteMany({ where: { incident: { orgId: ORG_A } } });
    await prisma.incidentPostmortem.deleteMany({ where: { orgId: ORG_A } });
    await prisma.incidentParticipant.deleteMany({ where: { incident: { orgId: ORG_A } } });
    await prisma.incident.deleteMany({ where: { orgId: ORG_A } });

    await statusService.seedDefaultComponents(ORG_A);
  });

  afterAll(async () => {
    await app.close();
  });

  it("publish creates unique public slugs", async () => {
    const first = await prisma.incident.create({
      data: { orgId: ORG_A, title: "API latency incident", severity: "HIGH" }
    });
    const second = await prisma.incident.create({
      data: { orgId: ORG_A, title: "API latency incident", severity: "HIGH" }
    });

    const firstPublish = await request(app.getHttpServer())
      .post(`/org/incidents/${first.id}/publish`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ publicSummary: "Investigating elevated latency.", componentKeys: ["api"] });
    expect(firstPublish.status).toBe(201);

    const secondPublish = await request(app.getHttpServer())
      .post(`/org/incidents/${second.id}/publish`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ publicSummary: "Still investigating.", componentKeys: ["api"] });
    expect(secondPublish.status).toBe(201);

    expect(firstPublish.body.publicSlug).toBeTruthy();
    expect(secondPublish.body.publicSlug).toBeTruthy();
    expect(firstPublish.body.publicSlug).not.toBe(secondPublish.body.publicSlug);
  });

  it("public endpoints return only published incidents", async () => {
    const pub = await prisma.incident.create({
      data: {
        orgId: ORG_A,
        title: "Public incident",
        severity: "CRITICAL",
        isPublic: true,
        publicSummary: "Public summary",
        publicSlug: "public-incident-1"
      }
    });

    await prisma.incident.create({
      data: {
        orgId: ORG_A,
        title: "Private incident",
        severity: "HIGH",
        isPublic: false
      }
    });

    const listResponse = await request(app.getHttpServer()).get("/status/incidents");
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.some((entry: { id: string }) => entry.id === pub.id)).toBe(true);
    expect(listResponse.body.every((entry: { title: string }) => entry.title !== "Private incident")).toBe(true);

    const slugResponse = await request(app.getHttpServer()).get("/status/incidents/public-incident-1");
    expect(slugResponse.status).toBe(200);
    expect(slugResponse.body.title).toBe("Public incident");
  });

  it("uptime scan stores checks and updates component status on repeated failures", async () => {
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 503 } as Response);

    for (let index = 0; index < 5; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await statusService.runUptimeScan();
    }

    const checks = await prisma.uptimeCheck.findMany({ where: { componentKey: "api" } });
    expect(checks.length).toBeGreaterThanOrEqual(5);

    const apiComponent = await prisma.statusComponent.findFirst({
      where: { orgId: ORG_A, key: "api" }
    });
    expect(apiComponent?.status).toBe("MAJOR_OUTAGE");

    fetchSpy.mockRestore();
  });
});
