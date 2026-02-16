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

describe("Org IP allowlist middleware", () => {
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

  beforeEach(async () => {
    await prisma.policy.upsert({
      where: { orgId: ORG_A },
      update: {
        ipRestrictionEnabled: false,
        ipAllowlist: []
      },
      create: {
        orgId: ORG_A,
        lockInvoiceOnSent: true,
        overdueAfterDays: 0,
        defaultWorkDueDays: 3,
        staleDealAfterDays: 7,
        leadStaleAfterHours: 72,
        requireDealOwner: true,
        requireWorkOwner: true,
        requireWorkDueDate: true,
        autoLockInvoiceAfterDays: 2,
        preventInvoiceUnlockAfterPartialPayment: true,
        autopilotEnabled: false,
        autopilotCreateWorkOnDealStageChange: true,
        autopilotNudgeOnOverdue: true,
        autopilotAutoStaleDeals: true,
        auditRetentionDays: 180,
        securityEventRetentionDays: 180,
        ipRestrictionEnabled: false,
        ipAllowlist: []
      }
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("allowed exact IP passes", async () => {
    await prisma.policy.update({
      where: { orgId: ORG_A },
      data: {
        ipRestrictionEnabled: true,
        ipAllowlist: ["203.0.113.10"]
      }
    });

    const response = await request(app.getHttpServer())
      .get("/billing/plan")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("x-forwarded-for", "203.0.113.10");

    expect(response.status).toBe(200);
  });

  it("disallowed IP is blocked", async () => {
    await prisma.policy.update({
      where: { orgId: ORG_A },
      data: {
        ipRestrictionEnabled: true,
        ipAllowlist: ["203.0.113.10"]
      }
    });

    const response = await request(app.getHttpServer())
      .get("/billing/plan")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("x-forwarded-for", "198.51.100.1");

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("IP_NOT_ALLOWED");
  });

  it("CIDR entry works", async () => {
    await prisma.policy.update({
      where: { orgId: ORG_A },
      data: {
        ipRestrictionEnabled: true,
        ipAllowlist: ["203.0.113.0/24"]
      }
    });

    const response = await request(app.getHttpServer())
      .get("/billing/plan")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("x-forwarded-for", "203.0.113.42");

    expect(response.status).toBe(200);
  });

  it("restriction disabled allows requests", async () => {
    await prisma.policy.update({
      where: { orgId: ORG_A },
      data: {
        ipRestrictionEnabled: false,
        ipAllowlist: ["203.0.113.10"]
      }
    });

    const response = await request(app.getHttpServer())
      .get("/billing/plan")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("x-forwarded-for", "198.51.100.99");

    expect(response.status).toBe(200);
  });
});
