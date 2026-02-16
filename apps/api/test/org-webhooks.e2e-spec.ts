import { BadRequestException, INestApplication, ValidationError, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { json, urlencoded } from "express";
import helmet from "helmet";
import { createHmac } from "node:crypto";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";
import { requestIdMiddleware } from "../src/common/middleware/request-id.middleware";
import { requestLoggingMiddleware } from "../src/common/middleware/request-logging.middleware";
import { WebhookService } from "../src/org-webhooks/webhook.service";
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

describe("Org Webhooks", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let webhookService: WebhookService;
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
    webhookService = app.get(WebhookService);
    adminToken = await login(app, "admina@test.kritviya.local");

    const plan = await prisma.plan.findUnique({ where: { key: "enterprise" }, select: { id: true } });
    if (!plan) {
      throw new Error("Missing enterprise plan");
    }
    enterprisePlanId = plan.id;
  });

  beforeEach(async () => {
    await prisma.subscription.upsert({
      where: { orgId: ORG_A },
      update: { planId: enterprisePlanId, status: "ACTIVE" },
      create: { orgId: ORG_A, planId: enterprisePlanId, status: "ACTIVE" }
    });
    await prisma.webhookEndpoint.deleteMany({ where: { orgId: ORG_A } });
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("creates webhook endpoint and returns secret once", async () => {
    const response = await request(app.getHttpServer())
      .post("/org/webhooks")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        url: "https://example.com/webhook",
        events: ["deal.created", "invoice.status_changed"]
      });

    expect(response.status).toBe(201);
    expect(response.body.id).toBeDefined();
    expect(response.body.secret).toBeDefined();
    expect(Array.isArray(response.body.events)).toBe(true);
    expect(response.body.events).toContain("deal.created");

    const list = await request(app.getHttpServer())
      .get("/org/webhooks")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    expect(list.body[0].secret).toBeUndefined();
  });

  it("dispatches event with HMAC signature", async () => {
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        orgId: ORG_A,
        url: "https://example.com/hook",
        secret: "test-secret",
        events: ["deal.created"]
      }
    });

    const payload = { orgId: ORG_A, dealId: "deal_1" };
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200
    } as Response);

    await webhookService.dispatch(ORG_A, "deal.created", payload);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const expectedSignature = createHmac("sha256", "test-secret")
      .update(JSON.stringify(payload))
      .digest("hex");

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(options.headers).toMatchObject({
      "X-Kritviya-Event": "deal.created",
      "X-Kritviya-Signature": expectedSignature
    });

    const refreshed = await prisma.webhookEndpoint.findUnique({ where: { id: endpoint.id } });
    expect(refreshed?.failureCount).toBe(0);
    expect(refreshed?.isActive).toBe(true);
  });

  it("disables endpoint after failure threshold", async () => {
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        orgId: ORG_A,
        url: "https://example.com/fail",
        secret: "test-secret",
        events: ["deal.updated"],
        failureCount: 9
      }
    });

    const fetchMock = jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    await webhookService.dispatch(ORG_A, "deal.updated", { orgId: ORG_A, dealId: "d_1" });

    expect(fetchMock).toHaveBeenCalledTimes(3);

    const refreshed = await prisma.webhookEndpoint.findUnique({ where: { id: endpoint.id } });
    expect(refreshed?.failureCount).toBe(10);
    expect(refreshed?.isActive).toBe(false);
    expect(refreshed?.lastFailureAt).not.toBeNull();
  });
});
