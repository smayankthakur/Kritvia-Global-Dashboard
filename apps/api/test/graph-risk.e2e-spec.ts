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

jest.setTimeout(60000);

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

describe("Graph risk endpoints", () => {
  let app: INestApplication;
  let ceoToken = "";
  let adminToken = "";
  let opsToken = "";
  let salesToken = "";

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

    ceoToken = await login(app, "ceoa@test.kritviya.local");
    adminToken = await login(app, "admina@test.kritviya.local");
    opsToken = await login(app, "opsa@test.kritviya.local");
    salesToken = await login(app, "salesa@test.kritviya.local");
  });

  afterAll(async () => {
    await app.close();
  });

  it("allows CEO/ADMIN/OPS to read risk summary and blocks SALES", async () => {
    const ceoResponse = await request(app.getHttpServer())
      .get("/ceo/risk")
      .set("Authorization", `Bearer ${ceoToken}`);
    expect(ceoResponse.status).toBe(200);
    expect(typeof ceoResponse.body.orgRiskScore).toBe("number");

    const opsResponse = await request(app.getHttpServer())
      .get("/ceo/risk")
      .set("Authorization", `Bearer ${opsToken}`);
    expect(opsResponse.status).toBe(200);

    const salesResponse = await request(app.getHttpServer())
      .get("/ceo/risk")
      .set("Authorization", `Bearer ${salesToken}`);
    expect(salesResponse.status).toBe(403);
  });

  it("allows only CEO/ADMIN to recompute risk", async () => {
    const adminResponse = await request(app.getHttpServer())
      .post("/graph/risk/recompute")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ scope: "ORG" });

    expect(adminResponse.status).toBe(201);
    expect(typeof adminResponse.body.orgRiskScore).toBe("number");

    const opsResponse = await request(app.getHttpServer())
      .post("/graph/risk/recompute")
      .set("Authorization", `Bearer ${opsToken}`)
      .send({ scope: "ORG" });

    expect(opsResponse.status).toBe(403);
  });
});
