import { BadRequestException, INestApplication, ValidationError, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { InvoiceStatus, Role } from "@prisma/client";
import { hash } from "bcryptjs";
import cookieParser from "cookie-parser";
import { json, urlencoded } from "express";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { AuthService } from "../src/auth/auth.service";
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

async function login(app: INestApplication, email: string, password: string = PASSWORD): Promise<string> {
  const response = await request(app.getHttpServer())
    .post("/auth/login")
    .send({ email, password });

  return response.body.accessToken as string;
}

describe("Sudarshan Shield Security Events", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken = "";
  let financeToken = "";
  let opsUserId = "";
  let adminUserId = "";
  let companyId = "";
  let dealId = "";
  let financeUserId = "";
  let authService: AuthService;
  let securityEvents: {
    deleteMany: (...args: unknown[]) => Promise<unknown>;
    findFirst: (...args: unknown[]) => Promise<any>;
  };

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
    authService = app.get(AuthService);
    securityEvents = (prisma as unknown as { securityEvent: any }).securityEvent;
    await securityEvents.deleteMany({ where: { orgId: ORG_A } });

    adminToken = await login(app, "admina@test.kritviya.local");
    financeToken = await login(app, "financea@test.kritviya.local");

    const ops = await prisma.user.findFirst({
      where: { orgId: ORG_A, email: "opsa@test.kritviya.local" },
      select: { id: true }
    });
    const admin = await prisma.user.findFirst({
      where: { orgId: ORG_A, email: "admina@test.kritviya.local" },
      select: { id: true }
    });
    const finance = await prisma.user.findFirst({
      where: { orgId: ORG_A, email: "financea@test.kritviya.local" },
      select: { id: true }
    });
    if (!ops || !finance || !admin) {
      throw new Error("Required users not seeded");
    }
    opsUserId = ops.id;
    adminUserId = admin.id;
    financeUserId = finance.id;

    companyId = randomUUID();
    await prisma.company.create({
      data: {
        id: companyId,
        orgId: ORG_A,
        name: `Shield Test Co ${Date.now()}`
      }
    });
    dealId = randomUUID();
    await prisma.deal.create({
      data: {
        id: dealId,
        orgId: ORG_A,
        title: "Shield test deal",
        companyId,
        ownerUserId: opsUserId
      }
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("creates INVOICE_UNLOCK event when invoice is manually unlocked", async () => {
    const invoiceId = randomUUID();
    await prisma.invoice.create({
      data: {
        id: invoiceId,
        orgId: ORG_A,
        companyId,
        dealId,
        status: InvoiceStatus.DRAFT,
        amount: 9000,
        currency: "INR",
        issueDate: new Date("2026-01-01"),
        dueDate: new Date("2026-01-20"),
        createdByUserId: financeUserId
      }
    });

    const send = await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/send`)
      .set("Authorization", `Bearer ${financeToken}`);
    expect(send.status).toBe(201);

    const unlock = await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/unlock`)
      .set("Authorization", `Bearer ${financeToken}`);
    expect(unlock.status).toBe(201);

    const event = await securityEvents.findFirst({
      where: {
        orgId: ORG_A,
        type: "INVOICE_UNLOCK",
        entityType: "INVOICE",
        entityId: invoiceId
      },
      orderBy: { createdAt: "desc" }
    });
    expect(event?.severity).toBe("HIGH");
  });

  it("creates ADMIN_ROLE_GRANTED event when user is promoted to admin", async () => {
    const tempPromoteUserId = randomUUID();
    const tempHash = await hash(PASSWORD, 10);
    await prisma.user.create({
      data: {
        id: tempPromoteUserId,
        orgId: ORG_A,
        name: "Promote Target",
        email: `promote.${Date.now()}@test.kritviya.local`,
        role: Role.SALES,
        passwordHash: tempHash,
        isActive: true
      }
    });

    const response = await request(app.getHttpServer())
      .patch(`/users/${tempPromoteUserId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ role: "ADMIN" });
    expect(response.status).toBe(200);

    const event = await securityEvents.findFirst({
      where: {
        orgId: ORG_A,
        type: "ADMIN_ROLE_GRANTED",
        entityType: "USER",
        entityId: tempPromoteUserId
      },
      orderBy: { createdAt: "desc" }
    });
    expect(event?.severity).toBe("CRITICAL");
  });

  it("creates BULK_USER_DEACTIVATION event when deactivation threshold is crossed", async () => {
    const hashValue = await hash(PASSWORD, 10);
    const bulkUsers = Array.from({ length: 4 }).map((_, index) => ({
      id: randomUUID(),
      orgId: ORG_A,
      name: `Bulk User ${index}`,
      email: `bulk${index}.${Date.now()}@test.kritviya.local`,
      role: Role.SALES,
      passwordHash: hashValue,
      isActive: true
    }));

    await prisma.user.createMany({ data: bulkUsers });
    for (const user of bulkUsers) {
      const response = await request(app.getHttpServer())
        .post(`/users/${user.id}/deactivate`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(response.status).toBe(201);
    }

    const event = await securityEvents.findFirst({
      where: {
        orgId: ORG_A,
        type: "BULK_USER_DEACTIVATION",
        userId: adminUserId
      },
      orderBy: { createdAt: "desc" }
    });
    expect(event?.severity).toBe("HIGH");
  });

  it("creates FAILED_LOGIN_SPIKE event after repeated failed logins", async () => {
    for (let index = 0; index < 6; index += 1) {
      await authService
        .login({
          email: "financea@test.kritviya.local",
          password: "wrong-password"
        })
        .catch(() => undefined);
    }

    const event = await securityEvents.findFirst({
      where: {
        orgId: ORG_A,
        type: "FAILED_LOGIN_SPIKE"
      },
      orderBy: { createdAt: "desc" }
    });
    expect(event?.severity).toBe("MEDIUM");
  });
});
