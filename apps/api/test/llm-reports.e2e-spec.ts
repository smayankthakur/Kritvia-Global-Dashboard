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

describe("LLM Reports", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken = "";
  let opsToken = "";
  let growthPlanId = "";

  beforeAll(async () => {
    process.env.LLM_ENABLED = "true";
    process.env.LLM_PROVIDER = "mock";

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

    const growthPlan = await prisma.plan.findUnique({
      where: { key: "growth" },
      select: { id: true }
    });
    if (!growthPlan?.id) {
      throw new Error("Growth plan missing");
    }
    growthPlanId = growthPlan.id;
  });

  beforeEach(async () => {
    process.env.LLM_MOCK_MODE = "valid";

    await prisma.subscription.upsert({
      where: { orgId: ORG_A },
      update: { planId: growthPlanId, status: "ACTIVE" },
      create: { orgId: ORG_A, planId: growthPlanId, status: "ACTIVE" }
    });

    await prisma.lLMReport.deleteMany({ where: { orgId: ORG_A } });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    delete process.env.LLM_MOCK_MODE;
  });

  it("generates CEO briefing with grounded JSON fields", async () => {
    const response = await request(app.getHttpServer())
      .post("/llm/reports/ceo-daily-brief")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ periodDays: 7 });

    expect(response.status).toBe(201);
    expect(response.body.cached).toBe(false);
    expect(response.body.contentJson.title).toBeTruthy();
    expect(response.body.contentJson.executiveSummary).toBeTruthy();
    expect(Array.isArray(response.body.contentJson.topRisks)).toBe(true);
    expect(Array.isArray(response.body.contentJson.recommendedNextActions)).toBe(true);
  });

  it("returns cached result for same input hash", async () => {
    const first = await request(app.getHttpServer())
      .post("/llm/reports/ceo-daily-brief")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ periodDays: 7 });
    expect(first.status).toBe(201);
    expect(first.body.cached).toBe(false);

    const second = await request(app.getHttpServer())
      .post("/llm/reports/ceo-daily-brief")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ periodDays: 7 });
    expect(second.status).toBe(201);
    expect(second.body.cached).toBe(true);
    expect(second.body.id).toBe(first.body.id);

    const count = await prisma.lLMReport.count({ where: { orgId: ORG_A, type: "CEO_DAILY_BRIEF" } });
    expect(count).toBe(1);
  });

  it("rejects malformed provider output", async () => {
    process.env.LLM_MOCK_MODE = "invalid";

    const response = await request(app.getHttpServer())
      .post("/llm/reports/ceo-daily-brief")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ periodDays: 7 });

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe("LLM_INVALID_OUTPUT");
  });

  it("enforces RBAC", async () => {
    const response = await request(app.getHttpServer())
      .post("/llm/reports/ceo-daily-brief")
      .set("Authorization", `Bearer ${opsToken}`)
      .send({ periodDays: 7 });

    expect(response.status).toBe(403);
  });
});
