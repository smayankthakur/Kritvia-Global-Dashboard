import { BadRequestException, INestApplication, ValidationError, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ActivityEntityType, DealStage, InvoiceStatus } from "@prisma/client";
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
  orgB: "20000000-0000-0000-0000-000000000001",
  adminB: "20000000-0000-0000-0000-000000000101"
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

describe("Revenue Velocity Integration", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminBToken = "";
  let opsAToken = "";

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
    adminBToken = await login(app, "adminb@test.kritviya.local");
    opsAToken = await login(app, "opsa@test.kritviya.local");
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("returns zero metrics when org has no lead/deal data", async () => {
    await prisma.activityLog.deleteMany({
      where: { orgId: IDS.orgB, entityType: ActivityEntityType.LEAD, action: "CONVERT" }
    });
    await prisma.deal.deleteMany({ where: { orgId: IDS.orgB } });
    await prisma.lead.deleteMany({ where: { orgId: IDS.orgB } });
    await prisma.company.deleteMany({ where: { orgId: IDS.orgB } });

    const response = await request(app.getHttpServer())
      .get("/ceo/revenue/velocity")
      .set("Authorization", `Bearer ${adminBToken}`);

    expect(response.status).toBe(200);
    expect(response.body.avgCloseDays).toBe(0);
    expect(response.body.stageConversion.leadToDealPct).toBe(0);
    expect(response.body.stageConversion.dealToWonPct).toBe(0);
    expect(response.body.dropOffPct).toBe(0);
    expect(response.body.pipelineAging).toEqual({
      "0_7": 0,
      "8_14": 0,
      "15_30": 0,
      "30_plus": 0
    });
  });

  it("computes avg close days, stage conversions, drop-off, and pipeline aging", async () => {
    const now = new Date();
    const companyId = "20000000-0000-0000-0000-000000000010";
    const leadIds = [
      "20000000-0000-0000-0000-000000000201",
      "20000000-0000-0000-0000-000000000202",
      "20000000-0000-0000-0000-000000000203",
      "20000000-0000-0000-0000-000000000204"
    ];

    await prisma.company.create({
      data: {
        id: companyId,
        orgId: IDS.orgB,
        name: "Velocity Company B"
      }
    });

    await prisma.lead.createMany({
      data: leadIds.map((id, index) => ({
        id,
        orgId: IDS.orgB,
        title: `Lead ${index + 1}`
      }))
    });

    await prisma.activityLog.createMany({
      data: [
        {
          orgId: IDS.orgB,
          actorUserId: IDS.adminB,
          entityType: ActivityEntityType.LEAD,
          entityId: leadIds[0],
          action: "CONVERT"
        },
        {
          orgId: IDS.orgB,
          actorUserId: IDS.adminB,
          entityType: ActivityEntityType.LEAD,
          entityId: leadIds[1],
          action: "CONVERT"
        }
      ]
    });

    await prisma.deal.createMany({
      data: [
        {
          id: "20000000-0000-0000-0000-000000000301",
          orgId: IDS.orgB,
          title: "Won Deal",
          companyId,
          stage: DealStage.WON,
          createdAt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
          updatedAt: now,
          wonAt: new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000),
          valueAmount: 50000
        },
        {
          id: "20000000-0000-0000-0000-000000000302",
          orgId: IDS.orgB,
          title: "Open Deal 9 Days",
          companyId,
          stage: DealStage.OPEN,
          createdAt: new Date(now.getTime() - 9 * 24 * 60 * 60 * 1000),
          updatedAt: now,
          valueAmount: 25000
        },
        {
          id: "20000000-0000-0000-0000-000000000303",
          orgId: IDS.orgB,
          title: "Open Deal 20 Days",
          companyId,
          stage: DealStage.OPEN,
          createdAt: new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000),
          updatedAt: now,
          valueAmount: 20000
        },
        {
          id: "20000000-0000-0000-0000-000000000304",
          orgId: IDS.orgB,
          title: "Lost Deal",
          companyId,
          stage: DealStage.LOST,
          createdAt: new Date(now.getTime() - 12 * 24 * 60 * 60 * 1000),
          updatedAt: now,
          valueAmount: 10000
        }
      ]
    });

    const response = await request(app.getHttpServer())
      .get("/ceo/revenue/velocity")
      .set("Authorization", `Bearer ${adminBToken}`);

    expect(response.status).toBe(200);
    expect(response.body.avgCloseDays).toBe(10);
    expect(response.body.stageConversion).toEqual({
      leadToDealPct: 50,
      dealToWonPct: 25
    });
    expect(response.body.pipelineAging).toEqual({
      "0_7": 0,
      "8_14": 1,
      "15_30": 1,
      "30_plus": 0
    });
    expect(response.body.dropOffPct).toBe(25);
    expect(response.body.counts).toEqual({
      leads: 4,
      deals: 4,
      won: 1,
      lost: 1,
      open: 2
    });
  });

  it("blocks non CEO/Admin roles", async () => {
    const response = await request(app.getHttpServer())
      .get("/ceo/revenue/velocity")
      .set("Authorization", `Bearer ${opsAToken}`);

    expect(response.status).toBe(403);
  });

  it("returns zero cashflow metrics when org has no deals and invoices", async () => {
    await prisma.activityLog.deleteMany({
      where: {
        orgId: IDS.orgB,
        entityType: ActivityEntityType.INVOICE,
        action: "MARK_PAID"
      }
    });
    await prisma.invoice.deleteMany({ where: { orgId: IDS.orgB } });
    await prisma.deal.deleteMany({ where: { orgId: IDS.orgB } });

    const response = await request(app.getHttpServer())
      .get("/ceo/revenue/cashflow")
      .set("Authorization", `Bearer ${adminBToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      outstandingReceivables: 0,
      avgPaymentDelayDays: 0,
      next30DaysForecast: 0,
      next60DaysForecast: 0,
      breakdown: {
        invoices: {
          dueIn30: 0,
          dueIn60: 0,
          overdue: 0
        },
        pipelineWeighted30: 0,
        pipelineWeighted60: 0
      }
    });
  });

  it("computes cashflow forecast from unpaid invoices and weighted open pipeline", async () => {
    const now = new Date();
    const companyId = "20000000-0000-0000-0000-000000000410";
    const dealIds = [
      "20000000-0000-0000-0000-000000000411",
      "20000000-0000-0000-0000-000000000412",
      "20000000-0000-0000-0000-000000000413"
    ];
    const invoiceIds = [
      "20000000-0000-0000-0000-000000000421",
      "20000000-0000-0000-0000-000000000422",
      "20000000-0000-0000-0000-000000000423",
      "20000000-0000-0000-0000-000000000424"
    ];
    const sentAt = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
    const paidAt = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);

    await prisma.activityLog.deleteMany({
      where: {
        orgId: IDS.orgB,
        entityType: ActivityEntityType.INVOICE,
        action: "MARK_PAID"
      }
    });
    await prisma.invoice.deleteMany({ where: { orgId: IDS.orgB } });
    await prisma.deal.deleteMany({ where: { orgId: IDS.orgB } });
    await prisma.company.deleteMany({ where: { orgId: IDS.orgB } });

    await prisma.company.create({
      data: {
        id: companyId,
        orgId: IDS.orgB,
        name: "Cashflow Co B"
      }
    });

    await prisma.deal.createMany({
      data: [
        {
          id: dealIds[0],
          orgId: IDS.orgB,
          title: "Deal 30-day",
          stage: DealStage.OPEN,
          valueAmount: 100000,
          companyId,
          expectedCloseDate: new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000)
        },
        {
          id: dealIds[1],
          orgId: IDS.orgB,
          title: "Deal 60-day",
          stage: DealStage.OPEN,
          valueAmount: 80000,
          companyId,
          expectedCloseDate: new Date(now.getTime() + 50 * 24 * 60 * 60 * 1000)
        },
        {
          id: dealIds[2],
          orgId: IDS.orgB,
          title: "Deal no close date",
          stage: DealStage.OPEN,
          valueAmount: 50000,
          companyId,
          expectedCloseDate: null
        }
      ]
    });

    await prisma.invoice.createMany({
      data: [
        {
          id: invoiceIds[0],
          orgId: IDS.orgB,
          companyId,
          dealId: dealIds[0],
          invoiceNumber: "CF-001",
          status: InvoiceStatus.SENT,
          amount: 12000,
          currency: "INR",
          issueDate: now,
          dueDate: new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000),
          createdByUserId: IDS.adminB
        },
        {
          id: invoiceIds[1],
          orgId: IDS.orgB,
          companyId,
          dealId: dealIds[1],
          invoiceNumber: "CF-002",
          status: InvoiceStatus.SENT,
          amount: 30000,
          currency: "INR",
          issueDate: now,
          dueDate: new Date(now.getTime() + 50 * 24 * 60 * 60 * 1000),
          createdByUserId: IDS.adminB
        },
        {
          id: invoiceIds[2],
          orgId: IDS.orgB,
          companyId,
          dealId: null,
          invoiceNumber: "CF-003",
          status: InvoiceStatus.OVERDUE,
          amount: 5000,
          currency: "INR",
          issueDate: now,
          dueDate: new Date(now.getTime() - 24 * 60 * 60 * 1000),
          createdByUserId: IDS.adminB
        },
        {
          id: invoiceIds[3],
          orgId: IDS.orgB,
          companyId,
          dealId: null,
          invoiceNumber: "CF-004",
          status: InvoiceStatus.PAID,
          amount: 9000,
          currency: "INR",
          sentAt,
          issueDate: now,
          dueDate: new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000),
          createdByUserId: IDS.adminB
        }
      ]
    });

    await prisma.activityLog.create({
      data: {
        orgId: IDS.orgB,
        actorUserId: IDS.adminB,
        entityType: ActivityEntityType.INVOICE,
        entityId: invoiceIds[3],
        action: "MARK_PAID",
        createdAt: paidAt
      }
    });

    const response = await request(app.getHttpServer())
      .get("/ceo/revenue/cashflow")
      .set("Authorization", `Bearer ${adminBToken}`);

    expect(response.status).toBe(200);
    expect(response.body.outstandingReceivables).toBe(47000);
    expect(response.body.avgPaymentDelayDays).toBe(4);
    expect(response.body.breakdown).toEqual({
      invoices: {
        dueIn30: 2,
        dueIn60: 3,
        overdue: 1
      },
      pipelineWeighted30: 46000,
      pipelineWeighted60: 84000
    });
    expect(response.body.next30DaysForecast).toBe(63000);
    expect(response.body.next60DaysForecast).toBe(131000);
  });

  it("blocks non CEO/Admin roles on cashflow endpoint", async () => {
    const response = await request(app.getHttpServer())
      .get("/ceo/revenue/cashflow")
      .set("Authorization", `Bearer ${opsAToken}`);

    expect(response.status).toBe(403);
  });
});
