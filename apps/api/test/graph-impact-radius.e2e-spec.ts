import { BadRequestException, INestApplication, ValidationError, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { json, urlencoded } from "express";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { AllExceptionsFilter } from "../src/common/filters/all-exceptions.filter";
import { requestIdMiddleware } from "../src/common/middleware/request-id.middleware";
import { requestLoggingMiddleware } from "../src/common/middleware/request-logging.middleware";
import { PrismaService } from "../src/prisma/prisma.service";

jest.setTimeout(60000);

const PASSWORD = "kritviyaTest123!";
const ORG_A = "10000000-0000-0000-0000-000000000001";
const ORG_B = "20000000-0000-0000-0000-000000000001";

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
  const response = await request(app.getHttpServer()).post("/auth/login").send({ email, password: PASSWORD });
  expect(response.status).toBe(201);
  return response.body.accessToken as string;
}

describe("Graph impact radius", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken = "";
  let salesToken = "";
  let adminBToken = "";

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
    salesToken = await login(app, "salesa@test.kritviya.local");
    adminBToken = await login(app, "adminb@test.kritviya.local");
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns deterministic impact radius with summary", async () => {
    const startNodeId = randomUUID();
    const workNodeId = randomUUID();
    const invoiceNodeId = randomUUID();
    const companyNodeId = randomUUID();

    await prisma.graphNode.createMany({
      data: [
        {
          id: startNodeId,
          orgId: ORG_A,
          type: "DEAL",
          entityId: randomUUID(),
          title: "Impact Deal",
          status: "OPEN",
          amountCents: 100000,
          riskScore: 40
        },
        {
          id: workNodeId,
          orgId: ORG_A,
          type: "WORK_ITEM",
          entityId: randomUUID(),
          title: "Impact Work",
          status: "TODO",
          dueAt: new Date(Date.now() - 60_000),
          riskScore: 80
        },
        {
          id: invoiceNodeId,
          orgId: ORG_A,
          type: "INVOICE",
          entityId: randomUUID(),
          title: "Impact Invoice",
          status: "OVERDUE",
          amountCents: 250000,
          dueAt: new Date(Date.now() - 60_000),
          riskScore: 60
        },
        {
          id: companyNodeId,
          orgId: ORG_A,
          type: "COMPANY",
          entityId: randomUUID(),
          title: "Impact Company",
          status: "ACTIVE",
          riskScore: 10
        }
      ]
    });

    const firstEdgeId = randomUUID();
    const secondEdgeId = randomUUID();
    const thirdEdgeId = randomUUID();
    await prisma.graphEdge.createMany({
      data: [
        {
          id: firstEdgeId,
          orgId: ORG_A,
          fromNodeId: startNodeId,
          toNodeId: workNodeId,
          type: "CREATED_FROM"
        },
        {
          id: secondEdgeId,
          orgId: ORG_A,
          fromNodeId: workNodeId,
          toNodeId: invoiceNodeId,
          type: "BILLED_BY"
        },
        {
          id: thirdEdgeId,
          orgId: ORG_A,
          fromNodeId: invoiceNodeId,
          toNodeId: companyNodeId,
          type: "RELATES_TO"
        }
      ]
    });

    const response = await request(app.getHttpServer())
      .post("/graph/impact-radius")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        startNodeId,
        maxDepth: 3,
        direction: "BOTH"
      });

    expect(response.status).toBe(201);
    expect(response.body.nodes.map((node: { id: string }) => node.id)).toEqual([
      startNodeId,
      workNodeId,
      invoiceNodeId,
      companyNodeId
    ]);
    expect(response.body.summary.moneyAtRiskCents).toBe(250000);
    expect(response.body.summary.overdueInvoicesCount).toBe(1);
    expect(response.body.summary.openWorkCount).toBe(1);
    expect(response.body.summary.overdueWorkCount).toBe(1);
    expect(response.body.summary.companiesImpactedCount).toBe(1);
    expect(response.body.summary.pathCountsByType.CREATED_FROM).toBe(1);
    expect(response.body.hotspots[0].id).toBe(workNodeId);
  });

  it("blocks SALES role for impact radius endpoint in MVP", async () => {
    const response = await request(app.getHttpServer())
      .post("/graph/impact-radius")
      .set("Authorization", `Bearer ${salesToken}`)
      .send({
        startNodeId: randomUUID(),
        maxDepth: 2
      });

    expect(response.status).toBe(403);
  });

  it("enforces org scoping and deeplink mapping", async () => {
    const bNodeId = randomUUID();
    await prisma.graphNode.create({
      data: {
        id: bNodeId,
        orgId: ORG_B,
        type: "DEAL",
        entityId: "20000000-0000-0000-0000-000000000020",
        title: "Org B Deal",
        status: "OPEN",
        riskScore: 5
      }
    });

    const forbidden = await request(app.getHttpServer())
      .get(`/graph/deeplink/${bNodeId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(forbidden.status).toBe(404);

    const allowed = await request(app.getHttpServer())
      .get(`/graph/deeplink/${bNodeId}`)
      .set("Authorization", `Bearer ${adminBToken}`);
    expect(allowed.status).toBe(200);
    expect(allowed.body.url).toBe("/sales/deals/20000000-0000-0000-0000-000000000020");
  });
});
