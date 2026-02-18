import { BadRequestException, INestApplication, ValidationError, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { createHash } from "node:crypto";
import { json, Request, Response as ExpressResponse, urlencoded } from "express";
import helmet from "helmet";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";
import { requestIdMiddleware } from "../src/common/middleware/request-id.middleware";
import { requestLoggingMiddleware } from "../src/common/middleware/request-logging.middleware";
import { PrismaService } from "../src/prisma/prisma.service";

jest.setTimeout(60000);

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

function hashPrivateToken(token: string): string {
  const salt = "testsalt";
  const digest = createHash("sha256").update(`${salt}:${token}`).digest("hex");
  return `sha256:${salt}:${digest}`;
}

describe("Status SSO", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    process.env.STATUS_SESSION_SECRET = process.env.STATUS_SESSION_SECRET || "status_session_secret_for_tests";
    process.env.STATUS_BASE_URL = process.env.STATUS_BASE_URL || "http://localhost:3000";
    process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || "test_resend_key";

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
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    await prisma.statusAuthToken.deleteMany({ where: { orgId: ORG_A } });
    await prisma.org.update({
      where: { id: ORG_A },
      data: {
        statusEnabled: true,
        slug: "test-org-a",
        statusVisibility: "PRIVATE_SSO",
        statusAllowedEmailDomains: ["client.com"]
      }
    });
  });

  it("request-link rejects disallowed domain", async () => {
    const response = await request(app.getHttpServer()).post("/status-auth/request-link").send({
      orgSlug: "test-org-a",
      email: "user@blocked.com"
    });

    expect(response.status).toBe(400);
  });

  it("verify consumes token once", async () => {
    const raw = "known-status-token";
    await prisma.statusAuthToken.create({
      data: {
        orgId: ORG_A,
        email: "member@client.com",
        tokenHash: createHash("sha256").update(raw).digest("hex"),
        expiresAt: new Date(Date.now() + 10 * 60_000)
      }
    });

    const first = await request(app.getHttpServer()).get(
      `/status-auth/verify?orgSlug=test-org-a&email=member@client.com&token=${encodeURIComponent(raw)}`
    );
    expect(first.status).toBe(200);
    expect(first.headers["set-cookie"]).toBeDefined();

    const second = await request(app.getHttpServer()).get(
      `/status-auth/verify?orgSlug=test-org-a&email=member@client.com&token=${encodeURIComponent(raw)}`
    );
    expect(second.status).toBe(401);
  });

  it("private status endpoints reject without session for PRIVATE_SSO", async () => {
    const response = await request(app.getHttpServer()).get("/status/o/test-org-a");
    expect(response.status).toBe(401);
    expect(response.body.error?.code).toBe("STATUS_AUTH_REQUIRED");
  });

  it("private token mode still works", async () => {
    const privateToken = "secret-status-token";
    await prisma.org.update({
      where: { id: ORG_A },
      data: {
        statusVisibility: "PRIVATE_TOKEN",
        statusAccessTokenHash: hashPrivateToken(privateToken)
      }
    });

    const denied = await request(app.getHttpServer()).get("/status/o/test-org-a");
    expect(denied.status).toBe(404);

    const allowed = await request(app.getHttpServer()).get(
      `/status/o/test-org-a?token=${encodeURIComponent(privateToken)}`
    );
    expect(allowed.status).toBe(200);
  });
});
