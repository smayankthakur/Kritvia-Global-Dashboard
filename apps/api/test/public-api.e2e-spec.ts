import { BadRequestException, INestApplication, ValidationError, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { json, urlencoded } from "express";
import helmet from "helmet";
import { createHash } from "node:crypto";
import { Role } from "@prisma/client";
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

describe("Public API v1", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminJwt = "";

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
    adminJwt = await login(app, "admina@test.kritviya.local");
  });

  beforeEach(async () => {
    await prisma.apiToken.deleteMany({ where: { orgId: ORG_A, name: { startsWith: "Public API Test" } } });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  async function createServiceToken(scopes: string[]): Promise<string> {
    const rawToken = `ktv_live_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}abcd1234`;
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");

    await prisma.apiToken.create({
      data: {
        orgId: ORG_A,
        name: `Public API Test ${Date.now()}`,
        role: Role.ADMIN,
        tokenHash,
        scopes,
        rateLimitPerHour: 1000,
        requestsThisHour: 0,
        hourWindowStart: new Date()
      }
    });

    return rawToken;
  }

  it("rejects JWT user auth on /api/v1 endpoints", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/v1/deals")
      .set("Authorization", `Bearer ${adminJwt}`);

    expect(response.status).toBe(401);
  });

  it("enforces API token scopes", async () => {
    const dealsToken = await createServiceToken(["read:deals"]);

    const dealsResponse = await request(app.getHttpServer())
      .get("/api/v1/deals")
      .set("Authorization", `Bearer ${dealsToken}`);

    expect(dealsResponse.status).toBe(200);
    expect(Array.isArray(dealsResponse.body.items)).toBe(true);

    const invoicesResponse = await request(app.getHttpServer())
      .get("/api/v1/invoices")
      .set("Authorization", `Bearer ${dealsToken}`);

    expect(invoicesResponse.status).toBe(403);
    expect(invoicesResponse.body.error.code).toBe("INSUFFICIENT_SCOPE");
  });

  it("returns X-Kritviya-Version header", async () => {
    const token = await createServiceToken(["read:deals"]);

    const response = await request(app.getHttpServer())
      .get("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.headers["x-kritviya-version"]).toBe("1");
  });
});
