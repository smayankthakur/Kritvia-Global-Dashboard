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

describe("Health Score Integration", () => {
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

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("upserts one snapshot per org/day when compute endpoint is called repeatedly", async () => {
    const dateKey = new Date().toISOString().slice(0, 10);
    await prisma.orgHealthSnapshot.deleteMany({
      where: { orgId: IDS.orgA, dateKey }
    });

    const first = await request(app.getHttpServer())
      .post("/jobs/compute-health-score")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(first.status).toBe(201);
    expect(first.body.dateKey).toBe(dateKey);
    expect(typeof first.body.score).toBe("number");

    const second = await request(app.getHttpServer())
      .post("/jobs/compute-health-score")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(second.status).toBe(201);
    expect(second.body.dateKey).toBe(dateKey);

    const count = await prisma.orgHealthSnapshot.count({
      where: { orgId: IDS.orgA, dateKey }
    });
    expect(count).toBe(1);
  });
});
