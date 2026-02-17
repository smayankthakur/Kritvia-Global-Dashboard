import { BadRequestException, INestApplication, ValidationError, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { json, Request, Response as ExpressResponse, urlencoded } from "express";
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

describe("Status Subscribers", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken = "";

  beforeAll(async () => {
    process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || "test_resend_key";
    process.env.API_BASE_URL = process.env.API_BASE_URL || "http://localhost:4000";
    process.env.WEB_BASE_URL = process.env.WEB_BASE_URL || "http://localhost:3000";
    process.env.APP_CONFIG_ENCRYPTION_KEY =
      process.env.APP_CONFIG_ENCRYPTION_KEY ||
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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
        verify: (req: Request & { rawBody?: Buffer }, _res: ExpressResponse, buf: Buffer) => {
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
    adminToken = await login(app, "admina@test.kritviya.local");
  });

  beforeEach(async () => {
    await prisma.statusNotificationLog.deleteMany({});
    await prisma.statusSubscription.deleteMany({});
    await prisma.statusSubscriber.deleteMany({});
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("email subscription requires confirmation", async () => {
    const response = await request(app.getHttpServer()).post("/status/subscribe").send({
      email: `status-${Date.now()}@test.kritviya.local`,
      componentKeys: ["api"]
    });

    expect(response.status).toBe(201);
    const subscriber = await prisma.statusSubscriber.findFirst({
      where: { email: { contains: "@test.kritviya.local" } },
      orderBy: { createdAt: "desc" }
    });
    expect(subscriber).not.toBeNull();
    expect(subscriber?.isConfirmed).toBe(false);

    const confirm = await request(app.getHttpServer()).get(`/status/confirm?token=${subscriber?.confirmationToken}`);
    expect(confirm.status).toBe(200);

    const refreshed = await prisma.statusSubscriber.findUnique({ where: { id: subscriber!.id } });
    expect(refreshed?.isConfirmed).toBe(true);
  });

  it("webhook subscription works and publish incident logs notification", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "ok"
    } as globalThis.Response);

    const subscribe = await request(app.getHttpServer()).post("/status/subscribe").send({
      webhookUrl: "https://example.com/status-hook",
      componentKeys: ["api"]
    });
    expect(subscribe.status).toBe(201);

    const incident = await prisma.incident.create({
      data: {
        orgId: ORG_A,
        title: "Status public incident test",
        severity: "HIGH",
        status: "OPEN"
      }
    });

    const publish = await request(app.getHttpServer())
      .post(`/org/incidents/${incident.id}/publish`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ publicSummary: "API is degraded", componentKeys: ["api"] });

    expect(publish.status).toBe(201);
    expect(fetchMock).toHaveBeenCalled();

    const logs = await prisma.statusNotificationLog.findMany({ where: { incidentId: incident.id } });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((row) => row.success)).toBe(true);

    fetchMock.mockRestore();
  });

  it("unsubscribe removes subscription", async () => {
    const subscribe = await request(app.getHttpServer()).post("/status/subscribe").send({
      email: `unsub-${Date.now()}@test.kritviya.local`
    });
    expect(subscribe.status).toBe(201);

    const subscriber = await prisma.statusSubscriber.findFirst({
      where: { email: { contains: "unsub-" } },
      orderBy: { createdAt: "desc" }
    });
    expect(subscriber).not.toBeNull();

    const unsub = await request(app.getHttpServer()).get(`/status/unsubscribe?token=${subscriber?.unsubToken}`);
    expect(unsub.status).toBe(200);

    const after = await prisma.statusSubscriber.findUnique({ where: { id: subscriber!.id } });
    expect(after).toBeNull();
  });
});
