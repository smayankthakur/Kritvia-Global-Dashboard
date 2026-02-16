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

describe("API token hourly rate limiting", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken = "";
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
    adminToken = await login(app, "admina@test.kritviya.local");
    const enterprisePlan = await prisma.plan.findUnique({
      where: { key: "enterprise" },
      select: { id: true }
    });
    if (!enterprisePlan) {
      throw new Error("Missing enterprise plan");
    }
    enterprisePlanId = enterprisePlan.id;
  });

  beforeEach(async () => {
    await prisma.subscription.upsert({
      where: { orgId: ORG_A },
      update: { planId: enterprisePlanId, status: "ACTIVE" },
      create: { orgId: ORG_A, planId: enterprisePlanId, status: "ACTIVE" }
    });
    await prisma.apiToken.deleteMany({ where: { orgId: ORG_A } });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("exceeding rate limit returns 429", async () => {
    const created = await request(app.getHttpServer())
      .post("/org/api-tokens")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Rate limit test token", role: "ADMIN" });
    expect(created.status).toBe(201);

    const rawToken = created.body.token as string;
    const tokenId = created.body.id as string;
    await prisma.apiToken.update({
      where: { id: tokenId },
      data: {
        rateLimitPerHour: 1
      }
    });

    const first = await request(app.getHttpServer())
      .get("/companies")
      .set("Authorization", `Bearer ${rawToken}`);
    expect(first.status).toBe(200);

    const second = await request(app.getHttpServer())
      .get("/companies")
      .set("Authorization", `Bearer ${rawToken}`);
    expect(second.status).toBe(429);
  });

  it("hour window resets after 1 hour", async () => {
    const created = await request(app.getHttpServer())
      .post("/org/api-tokens")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Rate reset token", role: "ADMIN" });
    expect(created.status).toBe(201);

    const rawToken = created.body.token as string;
    const tokenId = created.body.id as string;
    await prisma.apiToken.update({
      where: { id: tokenId },
      data: {
        rateLimitPerHour: 1,
        requestsThisHour: 1,
        hourWindowStart: new Date(Date.now() - 2 * 60 * 60 * 1000)
      }
    });

    const response = await request(app.getHttpServer())
      .get("/companies")
      .set("Authorization", `Bearer ${rawToken}`);
    expect(response.status).toBe(200);

    const updated = await prisma.apiToken.findUnique({
      where: { id: tokenId },
      select: {
        requestsThisHour: true,
        hourWindowStart: true,
        lastUsedAt: true
      }
    });

    expect(updated).toBeTruthy();
    expect(updated?.requestsThisHour).toBe(1);
    expect(updated?.hourWindowStart).toBeTruthy();
    expect(updated?.lastUsedAt).toBeTruthy();
    expect(
      Date.now() - new Date(updated?.hourWindowStart ?? 0).getTime()
    ).toBeLessThan(60 * 1000);
  });
});
