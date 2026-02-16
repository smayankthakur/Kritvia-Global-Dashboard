import { BadRequestException, INestApplication, ValidationError, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { json, Request, Response, urlencoded } from "express";
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

describe("Marketplace Foundation", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken = "";
  let ceoToken = "";
  let opsToken = "";
  let enterprisePlanId = "";

  beforeAll(async () => {
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
        verify: (req: Request & { rawBody?: Buffer }, _res: Response, buf: Buffer) => {
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
    ceoToken = await login(app, "ceoa@test.kritviya.local");
    opsToken = await login(app, "opsa@test.kritviya.local");

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
    await prisma.orgAppInstall.deleteMany({ where: { orgId: ORG_A } });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("lists only published apps", async () => {
    const hiddenKey = `hidden-${Date.now()}`;
    await prisma.marketplaceApp.create({
      data: {
        key: hiddenKey,
        name: "Hidden App",
        description: "Not published",
        isPublished: false
      }
    });

    const response = await request(app.getHttpServer())
      .get("/marketplace/apps")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.some((appItem: { key: string }) => appItem.key === hiddenKey)).toBe(false);
  });

  it("installs app idempotently for org", async () => {
    const first = await request(app.getHttpServer())
      .post("/org/apps/slack/install")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(first.status).toBe(201);
    expect(first.body.id).toBeDefined();
    expect(first.body.appSecret).toBeTruthy();

    const second = await request(app.getHttpServer())
      .post("/org/apps/slack/install")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(second.status).toBe(201);

    const appRecord = await prisma.marketplaceApp.findUnique({ where: { key: "slack" } });
    expect(appRecord).not.toBeNull();

    const count = await prisma.orgAppInstall.count({
      where: { orgId: ORG_A, appId: appRecord!.id }
    });
    expect(count).toBe(1);
  });

  it("allows CEO/Admin but blocks OPS for install/config/rotate/uninstall", async () => {
    const installByCeo = await request(app.getHttpServer())
      .post("/org/apps/google-sheets/install")
      .set("Authorization", `Bearer ${ceoToken}`);
    expect(installByCeo.status).toBe(201);

    const opsInstall = await request(app.getHttpServer())
      .post("/org/apps/google-sheets/install")
      .set("Authorization", `Bearer ${opsToken}`);
    expect(opsInstall.status).toBe(403);

    const opsConfig = await request(app.getHttpServer())
      .patch("/org/apps/google-sheets/config")
      .set("Authorization", `Bearer ${opsToken}`)
      .send({ config: { enabled: true } });
    expect(opsConfig.status).toBe(403);

    const opsRotate = await request(app.getHttpServer())
      .post("/org/apps/google-sheets/rotate-secret")
      .set("Authorization", `Bearer ${opsToken}`);
    expect(opsRotate.status).toBe(403);

    const opsUninstall = await request(app.getHttpServer())
      .delete("/org/apps/google-sheets/uninstall")
      .set("Authorization", `Bearer ${opsToken}`);
    expect(opsUninstall.status).toBe(403);
  });

  it("config update stores encrypted value and uninstall clears secrets/config", async () => {
    const install = await request(app.getHttpServer())
      .post("/org/apps/zapier/install")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(install.status).toBe(201);

    const updateConfig = await request(app.getHttpServer())
      .patch("/org/apps/zapier/config")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        config: {
          endpoint: "https://hooks.zapier.com/fake",
          apiKey: "plain-text-should-not-store"
        }
      });
    expect(updateConfig.status).toBe(200);

    const appRecord = await prisma.marketplaceApp.findUnique({ where: { key: "zapier" } });
    const installRecord = await prisma.orgAppInstall.findUnique({
      where: {
        orgId_appId: {
          orgId: ORG_A,
          appId: appRecord!.id
        }
      }
    });

    expect(installRecord).not.toBeNull();
    expect(installRecord?.configEncrypted).toBeTruthy();
    expect(installRecord?.configEncrypted).not.toContain("plain-text-should-not-store");
    expect(installRecord?.secretHash).toBeTruthy();

    const uninstall = await request(app.getHttpServer())
      .delete("/org/apps/zapier/uninstall")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(uninstall.status).toBe(200);

    const afterUninstall = await prisma.orgAppInstall.findUnique({
      where: {
        orgId_appId: {
          orgId: ORG_A,
          appId: appRecord!.id
        }
      }
    });
    expect(afterUninstall?.status).toBe("UNINSTALLED");
    expect(afterUninstall?.secretHash).toBeNull();
    expect(afterUninstall?.configEncrypted).toBeNull();
  });
});
