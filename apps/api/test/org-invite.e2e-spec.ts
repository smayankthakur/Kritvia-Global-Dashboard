import { BadRequestException, INestApplication, ValidationError, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { json, urlencoded } from "express";
import helmet from "helmet";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";
import { requestLoggingMiddleware } from "../src/common/middleware/request-logging.middleware";
import { requestIdMiddleware } from "../src/common/middleware/request-id.middleware";
import { PrismaService } from "../src/prisma/prisma.service";

jest.setTimeout(60000);

const IDS = {
  orgA: "10000000-0000-0000-0000-000000000001"
} as const;

const PASSWORD = "kritviyaTest123!";

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

function extractToken(inviteLink: string): string {
  const parsed = new URL(inviteLink);
  return parsed.searchParams.get("token") ?? "";
}

describe("Org Invite Lifecycle", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken = "";
  let opsToken = "";

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
    opsToken = await login(app, "opsa@test.kritviya.local");
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("invite creates token and INVITED membership", async () => {
    const email = `invite-a-${Date.now()}@test.kritviya.local`;
    const response = await request(app.getHttpServer())
      .post("/org/invite")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email, role: "OPS" });

    expect(response.status).toBe(201);
    expect(response.body.inviteLink).toContain("/accept-invite");
    expect(response.body.expiresAt).toBeDefined();

    const member = await prisma.orgMember.findUnique({
      where: {
        orgId_email: {
          orgId: IDS.orgA,
          email
        }
      }
    });
    expect(member?.status).toBe("INVITED");
    expect(member?.role).toBe("OPS");

    const tokenRow = await prisma.orgInviteToken.findFirst({
      where: {
        orgId: IDS.orgA,
        email,
        usedAt: null
      }
    });
    expect(tokenRow).toBeTruthy();
  });

  it("accept invite within expiry activates membership", async () => {
    const email = `invite-b-${Date.now()}@test.kritviya.local`;
    const invite = await request(app.getHttpServer())
      .post("/org/invite")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email, role: "SALES" });
    expect(invite.status).toBe(201);

    const accept = await request(app.getHttpServer()).post("/org/accept-invite").send({
      token: extractToken(invite.body.inviteLink),
      orgId: IDS.orgA,
      name: "Invited Sales",
      password: "KritviyaInvite123!"
    });
    expect(accept.status).toBe(201);
    expect(accept.body.success).toBe(true);
    expect(typeof accept.body.accessToken).toBe("string");

    const member = await prisma.orgMember.findUnique({
      where: {
        orgId_email: {
          orgId: IDS.orgA,
          email
        }
      }
    });
    expect(member?.status).toBe("ACTIVE");
    expect(member?.userId).toBeTruthy();
  });

  it("accept after expiry fails", async () => {
    const email = `invite-c-${Date.now()}@test.kritviya.local`;
    const invite = await request(app.getHttpServer())
      .post("/org/invite")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email, role: "OPS" });
    expect(invite.status).toBe(201);
    const token = extractToken(invite.body.inviteLink);

    await prisma.orgInviteToken.updateMany({
      where: { orgId: IDS.orgA, email, usedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) }
    });

    const accept = await request(app.getHttpServer()).post("/org/accept-invite").send({
      token,
      orgId: IDS.orgA,
      name: "Expired Invite User",
      password: "KritviyaInvite123!"
    });

    expect([400, 409]).toContain(accept.status);
  });

  it("token is single-use", async () => {
    const email = `invite-d-${Date.now()}@test.kritviya.local`;
    const invite = await request(app.getHttpServer())
      .post("/org/invite")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email, role: "FINANCE" });
    expect(invite.status).toBe(201);
    const token = extractToken(invite.body.inviteLink);

    const first = await request(app.getHttpServer()).post("/org/accept-invite").send({
      token,
      orgId: IDS.orgA,
      name: "Single Use User",
      password: "KritviyaInvite123!"
    });
    expect(first.status).toBe(201);

    const second = await request(app.getHttpServer()).post("/org/accept-invite").send({
      token,
      orgId: IDS.orgA,
      name: "Second Try User",
      password: "KritviyaInvite123!"
    });
    expect([400, 409]).toContain(second.status);
  });

  it("cannot invite without CEO/ADMIN role", async () => {
    const response = await request(app.getHttpServer())
      .post("/org/invite")
      .set("Authorization", `Bearer ${opsToken}`)
      .send({ email: `invite-e-${Date.now()}@test.kritviya.local`, role: "OPS" });

    expect(response.status).toBe(403);
  });
});

