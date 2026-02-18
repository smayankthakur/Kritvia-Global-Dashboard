import { BadRequestException, INestApplication, ValidationError, ValidationPipe } from "@nestjs/common";
import { Role } from "@prisma/client";
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
const ORG_A_ID = "10000000-0000-0000-0000-000000000001";

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

async function waitForCondition(check: () => Promise<boolean>): Promise<void> {
  const maxAttempts = 30;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for graph sync");
}

describe("Graph Auto-sync", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAToken = "";
  let adminBToken = "";
  let salesAToken = "";
  let opsAToken = "";
  let financeAToken = "";

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
    adminAToken = await login(app, "admina@test.kritviya.local");
    adminBToken = await login(app, "adminb@test.kritviya.local");
    salesAToken = await login(app, "salesa@test.kritviya.local");
    opsAToken = await login(app, "opsa@test.kritviya.local");
    financeAToken = await login(app, "financea@test.kritviya.local");
  });

  afterAll(async () => {
    await app.close();
  });

  it("create/update deal syncs graph node", async () => {
    const company = await prisma.company.create({
      data: {
        orgId: ORG_A_ID,
        name: `Graph Deal Co ${Date.now()}`
      }
    });

    const createResponse = await request(app.getHttpServer())
      .post("/deals")
      .set("Authorization", `Bearer ${salesAToken}`)
      .send({
        title: "Graph Sync Deal",
        companyId: company.id,
        valueAmount: 4200
      });
    expect(createResponse.status).toBe(201);
    const dealId = createResponse.body.id as string;

    await waitForCondition(async () => {
      const node = await prisma.graphNode.findUnique({
        where: {
          orgId_type_entityId: {
            orgId: ORG_A_ID,
            type: "DEAL",
            entityId: dealId
          }
        }
      });
      return !!node;
    });

    const updateResponse = await request(app.getHttpServer())
      .patch(`/deals/${dealId}`)
      .set("Authorization", `Bearer ${salesAToken}`)
      .send({ title: "Graph Sync Deal Updated" });
    expect(updateResponse.status).toBe(200);

    await waitForCondition(async () => {
      const node = await prisma.graphNode.findUnique({
        where: {
          orgId_type_entityId: {
            orgId: ORG_A_ID,
            type: "DEAL",
            entityId: dealId
          }
        }
      });
      return node?.title === "Graph Sync Deal Updated";
    });
  });

  it("create work item with dealId creates DEAL->WORK_ITEM edge", async () => {
    const company = await prisma.company.create({
      data: {
        orgId: ORG_A_ID,
        name: `Graph Work Co ${Date.now()}`
      }
    });
    const assignee = await prisma.user.create({
      data: {
        orgId: ORG_A_ID,
        name: "Graph Worker",
        email: `graph-worker-${Date.now()}@test.kritviya.local`,
        role: Role.OPS,
        passwordHash: "graph-not-used",
        isActive: true
      }
    });

    const dealResponse = await request(app.getHttpServer())
      .post("/deals")
      .set("Authorization", `Bearer ${salesAToken}`)
      .send({
        title: "Graph Work Deal",
        companyId: company.id,
        ownerUserId: assignee.id,
        valueAmount: 5000
      });
    expect(dealResponse.status).toBe(201);
    const dealId = dealResponse.body.id as string;

    const workResponse = await request(app.getHttpServer())
      .post("/work-items")
      .set("Authorization", `Bearer ${opsAToken}`)
      .send({
        title: "Graph Work Item",
        dealId,
        companyId: company.id,
        assignedToUserId: assignee.id,
        dueDate: "2027-01-01"
      });
    expect(workResponse.status).toBe(201);
    const workItemId = workResponse.body.id as string;

    await waitForCondition(async () => {
      const dealNode = await prisma.graphNode.findUnique({
        where: {
          orgId_type_entityId: {
            orgId: ORG_A_ID,
            type: "DEAL",
            entityId: dealId
          }
        }
      });
      const workNode = await prisma.graphNode.findUnique({
        where: {
          orgId_type_entityId: {
            orgId: ORG_A_ID,
            type: "WORK_ITEM",
            entityId: workItemId
          }
        }
      });
      if (!dealNode || !workNode) {
        return false;
      }
      const edge = await prisma.graphEdge.findUnique({
        where: {
          orgId_fromNodeId_toNodeId_type: {
            orgId: ORG_A_ID,
            fromNodeId: dealNode.id,
            toNodeId: workNode.id,
            type: "CREATED_FROM"
          }
        }
      });
      return !!edge;
    });
  });

  it("invoice send and mark-paid sync INVOICE node status", async () => {
    const company = await prisma.company.create({
      data: {
        orgId: ORG_A_ID,
        name: `Graph Invoice Co ${Date.now()}`
      }
    });
    const dealResponse = await request(app.getHttpServer())
      .post("/deals")
      .set("Authorization", `Bearer ${salesAToken}`)
      .send({
        title: "Graph Invoice Deal",
        companyId: company.id,
        valueAmount: 7500
      });
    expect(dealResponse.status).toBe(201);
    const dealId = dealResponse.body.id as string;

    const createInvoice = await request(app.getHttpServer())
      .post("/invoices")
      .set("Authorization", `Bearer ${financeAToken}`)
      .send({
        companyId: company.id,
        dealId,
        amount: 1200,
        dueDate: "2027-02-01",
        invoiceNumber: `GINV-${Date.now()}`
      });
    expect(createInvoice.status).toBe(201);
    const invoiceId = createInvoice.body.id as string;

    await waitForCondition(async () => {
      const node = await prisma.graphNode.findUnique({
        where: {
          orgId_type_entityId: {
            orgId: ORG_A_ID,
            type: "INVOICE",
            entityId: invoiceId
          }
        }
      });
      return node?.status === "DRAFT";
    });

    const sendResponse = await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/send`)
      .set("Authorization", `Bearer ${financeAToken}`);
    expect(sendResponse.status).toBe(201);

    await waitForCondition(async () => {
      const node = await prisma.graphNode.findUnique({
        where: {
          orgId_type_entityId: {
            orgId: ORG_A_ID,
            type: "INVOICE",
            entityId: invoiceId
          }
        }
      });
      return node?.status === "SENT";
    });

    const paidResponse = await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/mark-paid`)
      .set("Authorization", `Bearer ${financeAToken}`);
    expect(paidResponse.status).toBe(201);

    await waitForCondition(async () => {
      const node = await prisma.graphNode.findUnique({
        where: {
          orgId_type_entityId: {
            orgId: ORG_A_ID,
            type: "INVOICE",
            entityId: invoiceId
          }
        }
      });
      return node?.status === "PAID";
    });
  });

  it("repair endpoints enforce RBAC and org scoping", async () => {
    const company = await prisma.company.create({
      data: {
        orgId: ORG_A_ID,
        name: `Graph Repair Co ${Date.now()}`
      }
    });
    const dealResponse = await request(app.getHttpServer())
      .post("/deals")
      .set("Authorization", `Bearer ${salesAToken}`)
      .send({
        title: "Graph Repair Deal",
        companyId: company.id,
        valueAmount: 1000
      });
    expect(dealResponse.status).toBe(201);
    const dealId = dealResponse.body.id as string;

    const forbidden = await request(app.getHttpServer())
      .post(`/graph/repair/deal/${dealId}`)
      .set("Authorization", `Bearer ${opsAToken}`);
    expect(forbidden.status).toBe(403);

    const crossOrg = await request(app.getHttpServer())
      .post(`/graph/repair/deal/${dealId}`)
      .set("Authorization", `Bearer ${adminBToken}`);
    expect(crossOrg.status).toBe(404);

    const allowed = await request(app.getHttpServer())
      .post(`/graph/repair/deal/${dealId}`)
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(allowed.status).toBe(201);
    expect(allowed.body.node).toBeDefined();
    expect(typeof allowed.body.adjacentEdgesCount).toBe("number");
  });
});
