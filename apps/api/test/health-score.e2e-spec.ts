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
import { Prisma } from "@prisma/client";

jest.setTimeout(60000);

const IDS = {
  orgA: "10000000-0000-0000-0000-000000000001"
} as const;

const PASSWORD = "kritviyaTest123!";

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

describe("Health Score Integration", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken = "";

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
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("upserts one snapshot per org/day when compute endpoint is called repeatedly", async () => {
    const dateKey = new Date().toISOString().slice(0, 10);
    await prisma.orgHealthSnapshot.deleteMany({
      where: { orgId: IDS.orgA, dateKey }
    });

    const first = await request(app.getHttpServer())
      .post("/jobs/compute-health-score")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(first.status).toBe(201);
    expect(first.body.dateKey).toBe(dateKey);
    expect(typeof first.body.score).toBe("number");

    const second = await request(app.getHttpServer())
      .post("/jobs/compute-health-score")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(second.status).toBe(201);
    expect(second.body.dateKey).toBe(dateKey);

    const count = await prisma.orgHealthSnapshot.count({
      where: { orgId: IDS.orgA, dateKey }
    });
    expect(count).toBe(1);
  });

  it("returns explain drivers with deep links for penalty increases", async () => {
    const todayDate = new Date();
    const todayDateKey = todayDate.toISOString().slice(0, 10);
    const yesterdayDate = new Date(todayDate);
    yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
    const yesterdayDateKey = yesterdayDate.toISOString().slice(0, 10);

    const yesterdayBreakdown = {
      overdueWorkPct: 0.1,
      overdueInvoicePct: 0.1,
      staleDealsPct: 0.1,
      hygieneCount: 2,
      penalties: {
        overdueWorkPenalty: 4,
        overdueInvoicePenalty: 3,
        staleDealsPenalty: 2,
        hygienePenalty: 0
      },
      thresholds: { staleDays: 7 }
    };
    const todayBreakdown = {
      overdueWorkPct: 0.3,
      overdueInvoicePct: 0.1,
      staleDealsPct: 0.2,
      hygieneCount: 8,
      penalties: {
        overdueWorkPenalty: 12,
        overdueInvoicePenalty: 3,
        staleDealsPenalty: 4,
        hygienePenalty: 2
      },
      thresholds: { staleDays: 7 }
    };

    await prisma.orgHealthSnapshot.upsert({
      where: {
        orgId_dateKey: { orgId: IDS.orgA, dateKey: yesterdayDateKey }
      },
      create: {
        orgId: IDS.orgA,
        dateKey: yesterdayDateKey,
        score: 91,
        breakdown: yesterdayBreakdown as unknown as Prisma.InputJsonValue,
        computedAt: yesterdayDate
      },
      update: {
        score: 91,
        breakdown: yesterdayBreakdown as unknown as Prisma.InputJsonValue,
        computedAt: yesterdayDate
      }
    });

    await prisma.orgHealthSnapshot.upsert({
      where: {
        orgId_dateKey: { orgId: IDS.orgA, dateKey: todayDateKey }
      },
      create: {
        orgId: IDS.orgA,
        dateKey: todayDateKey,
        score: 79,
        breakdown: todayBreakdown as unknown as Prisma.InputJsonValue,
        computedAt: todayDate
      },
      update: {
        score: 79,
        breakdown: todayBreakdown as unknown as Prisma.InputJsonValue,
        computedAt: todayDate
      }
    });

    const response = await request(app.getHttpServer())
      .get(`/ceo/health-score/explain?date=${todayDateKey}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.body.dateKey).toBe(todayDateKey);
    expect(response.body.todayScore).toBe(79);
    expect(response.body.yesterdayScore).toBe(91);
    expect(response.body.delta).toBe(-12);
    expect(Array.isArray(response.body.drivers)).toBe(true);
    expect(response.body.drivers.length).toBeGreaterThan(0);
    expect(response.body.drivers[0].impactPoints).toBeGreaterThan(0);
    expect(typeof response.body.drivers[0].deepLink).toBe("string");
  });
});
