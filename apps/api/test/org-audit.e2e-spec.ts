import { BadRequestException, INestApplication, ValidationError, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { json, Request, Response, urlencoded } from "express";
import helmet from "helmet";
import request from "supertest";
import { ActivityEntityType } from "@prisma/client";
import { AppModule } from "../src/app.module";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";
import { requestIdMiddleware } from "../src/common/middleware/request-id.middleware";
import { requestLoggingMiddleware } from "../src/common/middleware/request-logging.middleware";
import { PrismaService } from "../src/prisma/prisma.service";

jest.setTimeout(60000);

const PASSWORD = "kritviyaTest123!";
const ORG_A = "10000000-0000-0000-0000-000000000001";
const ADMIN_A_EMAIL = "admina@test.kritviya.local";

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

describe("Org audit CSV export", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken = "";
  let adminUserId = "";
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
    app.use(
      json({
        limit: "1mb",
        verify: (req: Request & { rawBody?: Buffer }, _res: Response, buf: Buffer) => {
          req.rawBody = buf?.length ? Buffer.from(buf) : undefined;
        }
      })
    );
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

    const plans = await prisma.plan.findMany({
      where: { key: { in: ["starter", "enterprise"] } },
      select: { key: true, id: true }
    });
    starterPlanId = plans.find((plan) => plan.key === "starter")?.id ?? "";
    enterprisePlanId = plans.find((plan) => plan.key === "enterprise")?.id ?? "";
    if (!starterPlanId || !enterprisePlanId) {
      throw new Error("Missing required plans for org audit tests.");
    }

    await prisma.plan.update({
      where: { id: enterprisePlanId },
      data: { enterpriseControlsEnabled: true }
    });
    await prisma.plan.update({
      where: { id: starterPlanId },
      data: { enterpriseControlsEnabled: false }
    });

    const admin = await prisma.user.findUnique({
      where: { email: ADMIN_A_EMAIL },
      select: { id: true }
    });
    if (!admin) {
      throw new Error("Missing admin user for org audit tests.");
    }
    adminUserId = admin.id;

    adminToken = await login(app, ADMIN_A_EMAIL);
  });

  beforeEach(async () => {
    await prisma.subscription.upsert({
      where: { orgId: ORG_A },
      update: { planId: starterPlanId, status: "ACTIVE" },
      create: { orgId: ORG_A, planId: starterPlanId, status: "ACTIVE" }
    });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("returns UPGRADE_REQUIRED for non-enterprise plan", async () => {
    const response = await request(app.getHttpServer())
      .get("/org/audit/export?format=csv")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(response.status).toBe(402);
    expect(response.body.error.code).toBe("UPGRADE_REQUIRED");
  });

  it("rejects range over 180 days", async () => {
    await prisma.subscription.update({
      where: { orgId: ORG_A },
      data: { planId: enterprisePlanId }
    });

    const response = await request(app.getHttpServer())
      .get("/org/audit/export?format=csv&from=2025-01-01&to=2025-12-31")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_DATE_RANGE");
  });

  it("streams CSV with header and known action", async () => {
    await prisma.subscription.update({
      where: { orgId: ORG_A },
      data: { planId: enterprisePlanId }
    });

    await prisma.activityLog.create({
      data: {
        orgId: ORG_A,
        actorUserId: adminUserId,
        entityType: ActivityEntityType.USER,
        entityId: adminUserId,
        action: "USER_EXPORT_TEST",
        beforeJson: { before: true },
        afterJson: { after: true, requestId: "audit-test-request-id" }
      }
    });

    const response = await request(app.getHttpServer())
      .get("/org/audit/export?format=csv&from=2026-01-01&to=2026-12-31")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.text.startsWith("createdAt,actorUserId,actorEmail,action,entityType,entityId,metaJson,requestId")).toBe(true);
    expect(response.text).toContain("USER_EXPORT_TEST");
  });
});
