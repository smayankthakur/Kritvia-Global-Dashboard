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
import { createHmac } from "node:crypto";

jest.setTimeout(60000);

const PASSWORD = "kritviyaTest123!";
const ORG_A = "10000000-0000-0000-0000-000000000001";
const ORG_B = "20000000-0000-0000-0000-000000000001";
const ADMIN_B_EMAIL = "adminb@test.kritviya.local";

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

describe("Billing feature gating", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAToken = "";
  let adminBToken = "";
  let opsAToken = "";
  let starterPlanId = "";
  let proPlanId = "";
  let adminBUserId = "";

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
        verify: (req: any, _res: any, buf: Buffer) => {
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
    adminAToken = await login(app, "admina@test.kritviya.local");
    adminBToken = await login(app, ADMIN_B_EMAIL);
    opsAToken = await login(app, "opsa@test.kritviya.local");

    const adminB = await prisma.user.findUnique({
      where: { email: ADMIN_B_EMAIL },
      select: { id: true }
    });
    if (!adminB) {
      throw new Error("Missing adminB test user");
    }
    adminBUserId = adminB.id;

    const plans = await prisma.plan.findMany({
      where: { key: { in: ["starter", "pro"] } },
      select: { id: true, key: true }
    });
    starterPlanId = plans.find((plan) => plan.key === "starter")?.id ?? "";
    proPlanId = plans.find((plan) => plan.key === "pro")?.id ?? "";
    if (!starterPlanId || !proPlanId) {
      throw new Error("Required plans missing in test database");
    }
  });

  beforeEach(async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = "kritviya_webhook_test_secret";

    await prisma.subscription.upsert({
      where: { orgId: ORG_A },
      update: { planId: proPlanId, status: "ACTIVE" },
      create: { orgId: ORG_A, planId: proPlanId, status: "ACTIVE" }
    });

    await prisma.subscription.upsert({
      where: { orgId: ORG_B },
      update: { planId: starterPlanId, status: "ACTIVE" },
      create: { orgId: ORG_B, planId: starterPlanId, status: "ACTIVE" }
    });

    await prisma.plan.update({
      where: { id: starterPlanId },
      data: {
        seatLimit: 5,
        maxWorkItems: null,
        maxInvoices: null
      }
    });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("starter org cannot access portfolio endpoints", async () => {
    const response = await request(app.getHttpServer())
      .get("/portfolio")
      .set("Authorization", `Bearer ${adminBToken}`);

    expect(response.status).toBe(402);
    expect(response.body.error.code).toBe("UPGRADE_REQUIRED");
  });

  it("create-subscription is blocked for non-CEO/Admin roles", async () => {
    const response = await request(app.getHttpServer())
      .post("/billing/create-subscription")
      .set("Authorization", `Bearer ${opsAToken}`)
      .send({ planKey: "pro" });

    expect(response.status).toBe(403);
  });

  it("pro org can access portfolio endpoints", async () => {
    const create = await request(app.getHttpServer())
      .post("/portfolio")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ name: "Pro Portfolio Access" });
    expect(create.status).toBe(201);

    const list = await request(app.getHttpServer())
      .get("/portfolio")
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.items)).toBe(true);
  });

  it("seat limit reached blocks org invites", async () => {
    await prisma.plan.update({
      where: { id: starterPlanId },
      data: { seatLimit: 1 }
    });

    const response = await request(app.getHttpServer())
      .post("/org/invite")
      .set("Authorization", `Bearer ${adminBToken}`)
      .send({ email: "new.user@seat-limit.test", role: "OPS" });

    expect(response.status).toBe(402);
    expect(response.body.error.code).toBe("UPGRADE_REQUIRED");
    expect(response.body.error.message).toContain("Seat limit");
  });

  it("/org/usage returns usage counts", async () => {
    const response = await request(app.getHttpServer())
      .get("/org/usage")
      .set("Authorization", `Bearer ${adminBToken}`);

    expect(response.status).toBe(200);
    expect(typeof response.body.seatsUsed).toBe("number");
    expect(typeof response.body.workItemsUsed).toBe("number");
    expect(typeof response.body.invoicesUsed).toBe("number");
    expect(response.body.seatLimit).toBe(5);
    expect(response.body.maxWorkItems).toBeNull();
    expect(response.body.maxInvoices).toBeNull();
    expect(typeof response.body.updatedAt).toBe("string");
  });

  it("work item cap blocks create", async () => {
    await prisma.plan.update({
      where: { id: starterPlanId },
      data: { maxWorkItems: 0 }
    });

    const response = await request(app.getHttpServer())
      .post("/work-items")
      .set("Authorization", `Bearer ${adminBToken}`)
      .send({
        title: "Cap blocked work item",
        assignedToUserId: adminBUserId
      });

    expect(response.status).toBe(402);
    expect(response.body.error.code).toBe("UPGRADE_REQUIRED");
    expect(response.body.error.message).toContain("Work items limit");
  });

  it("invoice cap blocks create", async () => {
    await prisma.plan.update({
      where: { id: starterPlanId },
      data: { maxInvoices: 0 }
    });

    const company = await prisma.company.create({
      data: {
        orgId: ORG_B,
        name: `Invoice Cap Co ${Date.now()}`
      }
    });

    const response = await request(app.getHttpServer())
      .post("/invoices")
      .set("Authorization", `Bearer ${adminBToken}`)
      .send({
        companyId: company.id,
        amount: 1000,
        dueDate: "2026-12-31"
      });

    expect(response.status).toBe(402);
    expect(response.body.error.code).toBe("UPGRADE_REQUIRED");
    expect(response.body.error.message).toContain("Invoices limit");
  });

  it("starter org remains blocked until Razorpay webhook activates Pro plan", async () => {
    await prisma.subscription.update({
      where: { orgId: ORG_B },
      data: {
        planId: starterPlanId,
        status: "TRIAL",
        razorpaySubscriptionId: "sub_test_org_b"
      }
    });

    const blockedBefore = await request(app.getHttpServer())
      .get("/portfolio")
      .set("Authorization", `Bearer ${adminBToken}`);

    expect(blockedBefore.status).toBe(402);

    const payload = {
      event: "subscription.activated",
      payload: {
        subscription: {
          entity: {
            id: "sub_test_org_b",
            current_end: 1767225600,
            notes: {
              planKey: "pro"
            }
          }
        }
      }
    };
    const raw = JSON.stringify(payload);
    const signature = createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET || "")
      .update(raw)
      .digest("hex");

    const webhookResponse = await request(app.getHttpServer())
      .post("/billing/webhook")
      .set("x-razorpay-signature", signature)
      .set("Content-Type", "application/json")
      .send(raw);

    expect(webhookResponse.status).toBe(201);

    const allowedAfter = await request(app.getHttpServer())
      .get("/portfolio")
      .set("Authorization", `Bearer ${adminBToken}`);

    expect(allowedAfter.status).toBe(200);

    const updatedSubscription = await prisma.subscription.findUnique({
      where: { orgId: ORG_B },
      include: { plan: true }
    });
    expect(updatedSubscription?.status).toBe("ACTIVE");
    expect(updatedSubscription?.plan.key).toBe("pro");
  });
});
