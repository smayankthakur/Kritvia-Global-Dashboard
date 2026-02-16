import { BadRequestException, INestApplication, ValidationError, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DealStage, InvoiceStatus, NudgeStatus, WorkItemStatus } from "@prisma/client";
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
  adminA: "10000000-0000-0000-0000-000000000101",
  adminB: "20000000-0000-0000-0000-000000000101",
  companyA: "10000000-0000-0000-0000-000000000710",
  companyB: "20000000-0000-0000-0000-000000000710",
  dealA: "10000000-0000-0000-0000-000000000711",
  dealB: "20000000-0000-0000-0000-000000000711",
  invoiceA: "10000000-0000-0000-0000-000000000712",
  invoiceB: "20000000-0000-0000-0000-000000000712",
  workA: "10000000-0000-0000-0000-000000000713",
  workB: "20000000-0000-0000-0000-000000000713",
  nudgeA: "10000000-0000-0000-0000-000000000714",
  nudgeB: "20000000-0000-0000-0000-000000000714"
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

describe("Portfolio Module", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAToken = "";
  let adminBToken = "";
  let createdPortfolioId = "";
  type SummaryRow = {
    org: { id: string };
    kpis: {
      healthScore: number | null;
      openNudgesCount: number;
      outstandingReceivables: number;
      overdueWorkCount: number;
      criticalShieldCount: number;
    };
  };

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
  });

  beforeEach(async () => {
    await prisma.orgGroupOrg.deleteMany({});
    await prisma.orgGroupMember.deleteMany({});
    await prisma.orgGroup.deleteMany({});

    await prisma.nudge.deleteMany({
      where: { id: { in: [IDS.nudgeA, IDS.nudgeB] } }
    });
    await prisma.securityEvent.deleteMany({
      where: { orgId: { in: [IDS.orgA, IDS.orgB] } }
    });
    await prisma.workItem.deleteMany({
      where: { id: { in: [IDS.workA, IDS.workB] } }
    });
    await prisma.invoice.deleteMany({
      where: { id: { in: [IDS.invoiceA, IDS.invoiceB] } }
    });
    await prisma.deal.deleteMany({
      where: { id: { in: [IDS.dealA, IDS.dealB] } }
    });
    await prisma.company.deleteMany({
      where: { id: { in: [IDS.companyA, IDS.companyB] } }
    });
    await prisma.orgHealthSnapshot.deleteMany({
      where: { orgId: { in: [IDS.orgA, IDS.orgB] } }
    });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("cannot read portfolio summary without membership", async () => {
    const create = await request(app.getHttpServer())
      .post("/portfolio")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ name: "Owner Only Portfolio" });
    expect(create.status).toBe(201);
    createdPortfolioId = create.body.id;

    const summary = await request(app.getHttpServer())
      .get(`/portfolio/${createdPortfolioId}/summary`)
      .set("Authorization", `Bearer ${adminBToken}`);

    expect(summary.status).toBe(403);
  });

  it("cannot attach org unless actor is active member of that org", async () => {
    const create = await request(app.getHttpServer())
      .post("/portfolio")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ name: "Attachment Guard Portfolio" });
    expect(create.status).toBe(201);
    createdPortfolioId = create.body.id;

    const attach = await request(app.getHttpServer())
      .post(`/portfolio/${createdPortfolioId}/orgs`)
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ orgId: IDS.orgB });

    expect(attach.status).toBe(403);
  });

  it("returns merged KPI summary for multiple orgs in a portfolio", async () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const create = await request(app.getHttpServer())
      .post("/portfolio")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ name: "Portfolio KPI Summary" });
    expect(create.status).toBe(201);
    createdPortfolioId = create.body.id;

    await prisma.company.createMany({
      data: [
        { id: IDS.companyA, orgId: IDS.orgA, name: "Portfolio Co A" },
        { id: IDS.companyB, orgId: IDS.orgB, name: "Portfolio Co B" }
      ]
    });
    await prisma.deal.createMany({
      data: [
        {
          id: IDS.dealA,
          orgId: IDS.orgA,
          title: "Deal A",
          stage: DealStage.OPEN,
          companyId: IDS.companyA,
          ownerUserId: IDS.adminA,
          valueAmount: 80000
        },
        {
          id: IDS.dealB,
          orgId: IDS.orgB,
          title: "Deal B",
          stage: DealStage.OPEN,
          companyId: IDS.companyB,
          ownerUserId: IDS.adminB,
          valueAmount: 90000
        }
      ]
    });
    await prisma.invoice.createMany({
      data: [
        {
          id: IDS.invoiceA,
          orgId: IDS.orgA,
          companyId: IDS.companyA,
          dealId: IDS.dealA,
          status: InvoiceStatus.SENT,
          amount: 15000,
          currency: "INR",
          issueDate: now,
          dueDate: yesterday,
          createdByUserId: IDS.adminA
        },
        {
          id: IDS.invoiceB,
          orgId: IDS.orgB,
          companyId: IDS.companyB,
          dealId: IDS.dealB,
          status: InvoiceStatus.SENT,
          amount: 22000,
          currency: "INR",
          issueDate: now,
          dueDate: yesterday,
          createdByUserId: IDS.adminB
        }
      ]
    });
    await prisma.workItem.createMany({
      data: [
        {
          id: IDS.workA,
          orgId: IDS.orgA,
          title: "Overdue A",
          status: WorkItemStatus.TODO,
          dueDate: yesterday,
          createdByUserId: IDS.adminA,
          companyId: IDS.companyA,
          dealId: IDS.dealA
        },
        {
          id: IDS.workB,
          orgId: IDS.orgB,
          title: "Overdue B",
          status: WorkItemStatus.TODO,
          dueDate: yesterday,
          createdByUserId: IDS.adminB,
          companyId: IDS.companyB,
          dealId: IDS.dealB
        }
      ]
    });
    await prisma.nudge.createMany({
      data: [
        {
          id: IDS.nudgeA,
          orgId: IDS.orgA,
          createdByUserId: IDS.adminA,
          targetUserId: IDS.adminA,
          entityType: "DEAL",
          entityId: IDS.dealA,
          message: "Open nudge A",
          status: NudgeStatus.OPEN
        },
        {
          id: IDS.nudgeB,
          orgId: IDS.orgB,
          createdByUserId: IDS.adminB,
          targetUserId: IDS.adminB,
          entityType: "DEAL",
          entityId: IDS.dealB,
          message: "Open nudge B",
          status: NudgeStatus.OPEN
        }
      ]
    });
    await prisma.securityEvent.createMany({
      data: [
        {
          orgId: IDS.orgA,
          type: "TEST_CRITICAL",
          severity: "CRITICAL",
          description: "Critical A"
        },
        {
          orgId: IDS.orgB,
          type: "TEST_CRITICAL",
          severity: "CRITICAL",
          description: "Critical B"
        }
      ]
    });
    await prisma.orgHealthSnapshot.createMany({
      data: [
        {
          orgId: IDS.orgA,
          dateKey: "2026-02-14",
          score: 40,
          computedAt: new Date("2026-02-14T00:00:00.000Z"),
          breakdown: {
            test: "old"
          }
        },
        {
          orgId: IDS.orgA,
          dateKey: now.toISOString().slice(0, 10),
          score: 78,
          computedAt: new Date("2026-02-15T10:00:00.000Z"),
          breakdown: {
            test: true
          }
        },
        {
          orgId: IDS.orgB,
          dateKey: now.toISOString().slice(0, 10),
          score: 64,
          computedAt: new Date("2026-02-15T11:00:00.000Z"),
          breakdown: {
            test: true
          }
        }
      ]
    });

    await prisma.orgGroupOrg.createMany({
      data: [
        { groupId: createdPortfolioId, orgId: IDS.orgA },
        { groupId: createdPortfolioId, orgId: IDS.orgB }
      ]
    });

    const summary = await request(app.getHttpServer())
      .get(`/portfolio/${createdPortfolioId}/summary`)
      .set("Authorization", `Bearer ${adminAToken}`);

    expect(summary.status).toBe(200);
    expect(summary.body.group.id).toBe(createdPortfolioId);
    expect(Array.isArray(summary.body.rows)).toBe(true);
    expect(summary.body.rows).toHaveLength(2);

    const rowA = (summary.body.rows as SummaryRow[]).find((row) => row.org.id === IDS.orgA);
    const rowB = (summary.body.rows as SummaryRow[]).find((row) => row.org.id === IDS.orgB);

    expect(rowA.kpis.healthScore).toBe(78);
    expect(rowA.kpis.openNudgesCount).toBe(1);
    expect(rowA.kpis.outstandingReceivables).toBe(15000);
    expect(rowA.kpis.overdueWorkCount).toBe(1);
    expect(rowA.kpis.criticalShieldCount).toBe(1);

    expect(rowB.kpis.healthScore).toBe(64);
    expect(rowB.kpis.openNudgesCount).toBe(1);
    expect(rowB.kpis.outstandingReceivables).toBe(22000);
    expect(rowB.kpis.overdueWorkCount).toBe(1);
    expect(rowB.kpis.criticalShieldCount).toBe(1);
  });
});
