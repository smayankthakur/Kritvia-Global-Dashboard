import { BadRequestException, INestApplication, ValidationError, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { InvoiceStatus, WorkItemStatus } from "@prisma/client";
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
  orgA: "10000000-0000-0000-0000-000000000001",
  orgB: "20000000-0000-0000-0000-000000000001",
  adminB: "20000000-0000-0000-0000-000000000101",
  companyB: "20000000-0000-0000-0000-000000000510",
  dealB: "20000000-0000-0000-0000-000000000511",
  invoiceB: "20000000-0000-0000-0000-000000000512",
  workItemB: "20000000-0000-0000-0000-000000000513"
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

describe("Active Org Scoping", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAToken = "";

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
  });

  beforeEach(async () => {
    await prisma.workItem.deleteMany({ where: { id: IDS.workItemB } });
    await prisma.invoice.deleteMany({ where: { id: IDS.invoiceB } });
    await prisma.deal.deleteMany({ where: { id: IDS.dealB } });
    await prisma.company.deleteMany({ where: { id: IDS.companyB } });

    await prisma.company.create({
      data: {
        id: IDS.companyB,
        orgId: IDS.orgB,
        name: `Org B Company ${Date.now()}`
      }
    });

    await prisma.deal.create({
      data: {
        id: IDS.dealB,
        orgId: IDS.orgB,
        title: "Org B Deal",
        companyId: IDS.companyB,
        ownerUserId: IDS.adminB,
        valueAmount: 50000
      }
    });

    await prisma.invoice.create({
      data: {
        id: IDS.invoiceB,
        orgId: IDS.orgB,
        invoiceNumber: "ORG-B-INV-1",
        companyId: IDS.companyB,
        dealId: IDS.dealB,
        status: InvoiceStatus.DRAFT,
        amount: 12000,
        currency: "INR",
        issueDate: new Date("2026-02-01"),
        dueDate: new Date("2026-02-28"),
        createdByUserId: IDS.adminB
      }
    });

    await prisma.workItem.create({
      data: {
        id: IDS.workItemB,
        orgId: IDS.orgB,
        title: "Org B Work",
        status: WorkItemStatus.TODO,
        createdByUserId: IDS.adminB,
        companyId: IDS.companyB,
        dealId: IDS.dealB
      }
    });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("token scoped to active org A cannot access org B resources (404)", async () => {
    const getInvoice = await request(app.getHttpServer())
      .get(`/invoices/${IDS.invoiceB}`)
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(getInvoice.status).toBe(404);

    const getWorkItem = await request(app.getHttpServer())
      .get(`/work-items/${IDS.workItemB}`)
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(getWorkItem.status).toBe(404);

    const patchDeal = await request(app.getHttpServer())
      .patch(`/deals/${IDS.dealB}`)
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ title: "Cross Org Update Attempt" });
    expect(patchDeal.status).toBe(404);
  });

  it("switch-org issues token that scopes access to org B", async () => {
    const switched = await request(app.getHttpServer())
      .post("/auth/switch-org")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ orgId: IDS.orgB });

    expect(switched.status).toBe(201);
    expect(typeof switched.body.accessToken).toBe("string");
    const switchedToken = switched.body.accessToken as string;

    const me = await request(app.getHttpServer())
      .get("/auth/me")
      .set("Authorization", `Bearer ${switchedToken}`);
    expect(me.status).toBe(200);
    expect(me.body.orgId).toBe(IDS.orgB);

    const getInvoice = await request(app.getHttpServer())
      .get(`/invoices/${IDS.invoiceB}`)
      .set("Authorization", `Bearer ${switchedToken}`);
    expect(getInvoice.status).toBe(200);

    const getWorkItem = await request(app.getHttpServer())
      .get(`/work-items/${IDS.workItemB}`)
      .set("Authorization", `Bearer ${switchedToken}`);
    expect(getWorkItem.status).toBe(200);

    const patchDeal = await request(app.getHttpServer())
      .patch(`/deals/${IDS.dealB}`)
      .set("Authorization", `Bearer ${switchedToken}`)
      .send({ title: "Org B Deal Updated" });
    expect(patchDeal.status).toBe(200);
    expect(patchDeal.body.title).toBe("Org B Deal Updated");
  });
});

