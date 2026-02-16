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

async function waitForApiTokenUsageLog(
  prisma: PrismaService,
  tokenId: string,
  expectedSuccess: boolean
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const log = await prisma.activityLog.findFirst({
      where: {
        action: "API_TOKEN_USED",
        entityId: tokenId
      },
      orderBy: { createdAt: "desc" }
    });

    const meta = log?.afterJson as { success?: boolean } | null;
    if (log && meta?.success === expectedSuccess) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for API_TOKEN_USED log success=${String(expectedSuccess)}`);
}

describe("API Tokens (Service Accounts)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken = "";
  let enterprisePlanId = "";
  let starterPlanId = "";

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

    const plans = await prisma.plan.findMany({
      where: { key: { in: ["starter", "enterprise"] } },
      select: { key: true, id: true }
    });
    enterprisePlanId = plans.find((p) => p.key === "enterprise")?.id ?? "";
    starterPlanId = plans.find((p) => p.key === "starter")?.id ?? "";
    if (!enterprisePlanId || !starterPlanId) {
      throw new Error("Missing required plans");
    }
  });

  beforeEach(async () => {
    await prisma.apiToken.deleteMany({ where: { orgId: ORG_A } });
    await prisma.subscription.upsert({
      where: { orgId: ORG_A },
      update: { planId: enterprisePlanId, status: "ACTIVE" },
      create: { orgId: ORG_A, planId: enterprisePlanId, status: "ACTIVE" }
    });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("create token returns raw token once", async () => {
    const response = await request(app.getHttpServer())
      .post("/org/api-tokens")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Automation Bot", role: "ADMIN" });

    expect(response.status).toBe(201);
    expect(response.body.id).toBeDefined();
    expect(response.body.name).toBe("Automation Bot");
    expect(response.body.role).toBe("ADMIN");
    expect(typeof response.body.token).toBe("string");
    expect(response.body.token.startsWith("ktv_live_")).toBe(true);
    expect(response.body.token.length).toBeGreaterThanOrEqual(40);
  });

  it("list does not return raw token or tokenHash", async () => {
    await request(app.getHttpServer())
      .post("/org/api-tokens")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "List Test" });

    const list = await request(app.getHttpServer())
      .get("/org/api-tokens")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    expect(list.body.length).toBeGreaterThan(0);
    expect(list.body[0].token).toBeUndefined();
    expect(list.body[0].tokenHash).toBeUndefined();
  });

  it("valid api token authenticates and can access org endpoint", async () => {
    const created = await request(app.getHttpServer())
      .post("/org/api-tokens")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Service Access", role: "ADMIN" });
    expect(created.status).toBe(201);

    const serviceToken = created.body.token as string;
    const companies = await request(app.getHttpServer())
      .get("/companies")
      .set("Authorization", `Bearer ${serviceToken}`);

    expect(companies.status).toBe(200);
    expect(Array.isArray(companies.body.items)).toBe(true);

    const dbToken = await prisma.apiToken.findFirst({
      where: { orgId: ORG_A, name: "Service Access" },
      select: { id: true, lastUsedAt: true }
    });
    expect(dbToken?.id).toBeDefined();
    expect(dbToken?.lastUsedAt).toBeTruthy();
    await waitForApiTokenUsageLog(prisma, dbToken?.id ?? "", true);
    const usageLog = await prisma.activityLog.findFirst({
      where: {
        action: "API_TOKEN_USED",
        entityId: dbToken?.id ?? ""
      },
      orderBy: { createdAt: "desc" }
    });
    const usageMeta = usageLog?.afterJson as
      | { method?: string; endpoint?: string; ip?: string; statusCode?: number; success?: boolean }
      | null;
    expect(usageLog?.entityType).toBe("API_TOKEN");
    expect(usageMeta?.method).toBe("GET");
    expect(usageMeta?.endpoint).toContain("/companies");
    expect(typeof usageMeta?.ip).toBe("string");
    expect(usageMeta?.statusCode).toBe(200);
    expect(usageMeta?.success).toBe(true);
  });

  it("token with read:deals scope can access GET /deals", async () => {
    const created = await request(app.getHttpServer())
      .post("/org/api-tokens")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Deals Reader", role: "ADMIN", scopes: ["read:deals"] });
    expect(created.status).toBe(201);

    const serviceToken = created.body.token as string;
    const response = await request(app.getHttpServer())
      .get("/deals")
      .set("Authorization", `Bearer ${serviceToken}`);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.items)).toBe(true);
  });

  it("token without write:invoices scope cannot POST /invoices", async () => {
    const created = await request(app.getHttpServer())
      .post("/org/api-tokens")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "No Invoice Writer", role: "ADMIN", scopes: ["read:deals"] });
    expect(created.status).toBe(201);

    const serviceToken = created.body.token as string;
    const response = await request(app.getHttpServer())
      .post("/invoices")
      .set("Authorization", `Bearer ${serviceToken}`)
      .send({});

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("INSUFFICIENT_SCOPE");
  });

  it("revoked token fails with 401", async () => {
    const created = await request(app.getHttpServer())
      .post("/org/api-tokens")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Revoke Me", role: "ADMIN" });
    expect(created.status).toBe(201);

    const tokenId = created.body.id as string;
    const token = created.body.token as string;
    const revoke = await request(app.getHttpServer())
      .delete(`/org/api-tokens/${tokenId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(revoke.status).toBe(200);

    const afterRevoke = await request(app.getHttpServer())
      .get("/companies")
      .set("Authorization", `Bearer ${token}`);
    expect(afterRevoke.status).toBe(401);

    await waitForApiTokenUsageLog(prisma, tokenId, false);
    const failedLog = await prisma.activityLog.findFirst({
      where: {
        action: "API_TOKEN_USED",
        entityId: tokenId
      },
      orderBy: { createdAt: "desc" }
    });
    const failedMeta = failedLog?.afterJson as { statusCode?: number; success?: boolean } | null;
    expect(failedLog?.entityType).toBe("API_TOKEN");
    expect(failedMeta?.statusCode).toBe(401);
    expect(failedMeta?.success).toBe(false);
  });

  it("non-enterprise plan blocks token creation", async () => {
    await prisma.subscription.update({
      where: { orgId: ORG_A },
      data: { planId: starterPlanId, status: "ACTIVE" }
    });

    const response = await request(app.getHttpServer())
      .post("/org/api-tokens")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Blocked token" });

    expect(response.status).toBe(402);
    expect(response.body.error.code).toBe("UPGRADE_REQUIRED");
  });
});
