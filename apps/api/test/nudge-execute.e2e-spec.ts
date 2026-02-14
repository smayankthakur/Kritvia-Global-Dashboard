import { BadRequestException, INestApplication, ValidationError, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ActivityEntityType, NudgeType, Role, WorkItemStatus } from "@prisma/client";
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

describe("Nudge Execute/Undo", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken = "";
  let opsToken = "";
  let opsUserId = "";
  let financeUserId = "";
  let companyId = "";
  let workItemId = "";
  let nudgeId = "";

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

    const ops = await prisma.user.findFirst({
      where: { orgId: ORG_A, role: Role.OPS },
      select: { id: true }
    });
    const finance = await prisma.user.findFirst({
      where: { orgId: ORG_A, role: Role.FINANCE },
      select: { id: true }
    });
    if (!ops || !finance) {
      throw new Error("Missing seeded users");
    }
    opsUserId = ops.id;
    financeUserId = finance.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it("executes overdue work nudge and undoes within window", async () => {
    companyId = randomUUID();
    await prisma.company.create({
      data: {
        id: companyId,
        orgId: ORG_A,
        name: `Nudge Exec Co ${Date.now()}`
      }
    });

    workItemId = randomUUID();
    await prisma.workItem.create({
      data: {
        id: workItemId,
        orgId: ORG_A,
        title: "Execute overdue task",
        status: WorkItemStatus.TODO,
        dueDate: new Date("2026-01-01"),
        assignedToUserId: null,
        createdByUserId: financeUserId,
        companyId
      }
    });

    nudgeId = randomUUID();
    await prisma.nudge.create({
      data: {
        id: nudgeId,
        orgId: ORG_A,
        createdByUserId: financeUserId,
        targetUserId: opsUserId,
        type: NudgeType.OVERDUE_WORK,
        entityType: ActivityEntityType.WORK_ITEM,
        entityId: workItemId,
        message: "Fix this overdue work item",
        actionPayload: {
          assignedToUserId: opsUserId,
          dueDate: "2026-03-01T00:00:00.000Z"
        }
      }
    });

    const execute = await request(app.getHttpServer())
      .post(`/nudges/${nudgeId}/execute`)
      .set("Authorization", `Bearer ${opsToken}`);
    expect(execute.status).toBe(201);
    expect(execute.body.success).toBe(true);
    expect(execute.body.undoExpiresAt).toBeTruthy();

    const updatedWorkItem = await prisma.workItem.findUniqueOrThrow({ where: { id: workItemId } });
    expect(updatedWorkItem.assignedToUserId).toBe(opsUserId);
    expect(updatedWorkItem.dueDate?.toISOString().slice(0, 10)).toBe("2026-03-01");

    const undo = await request(app.getHttpServer())
      .post(`/nudges/${nudgeId}/undo`)
      .set("Authorization", `Bearer ${opsToken}`);
    expect(undo.status).toBe(201);
    expect(undo.body.success).toBe(true);

    const revertedWorkItem = await prisma.workItem.findUniqueOrThrow({ where: { id: workItemId } });
    expect(revertedWorkItem.assignedToUserId).toBeNull();
    expect(revertedWorkItem.dueDate?.toISOString().slice(0, 10)).toBe("2026-01-01");
  });

  it("blocks undo after expiry", async () => {
    const execute = await request(app.getHttpServer())
      .post(`/nudges/${nudgeId}/execute`)
      .set("Authorization", `Bearer ${opsToken}`);
    expect(execute.status).toBe(201);

    await prisma.nudge.update({
      where: { id: nudgeId },
      data: {
        undoExpiresAt: new Date(Date.now() - 1000)
      }
    });

    const undo = await request(app.getHttpServer())
      .post(`/nudges/${nudgeId}/undo`)
      .set("Authorization", `Bearer ${opsToken}`);
    expect(undo.status).toBe(409);
  });

  it("cannot execute twice", async () => {
    await prisma.nudge.update({
      where: { id: nudgeId },
      data: {
        executedAt: new Date(),
        undoExpiresAt: new Date(Date.now() + 60000),
        undoData: { marker: true },
        actionType: "WORK_ITEM_UPDATE"
      }
    });

    const response = await request(app.getHttpServer())
      .post(`/nudges/${nudgeId}/execute`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(response.status).toBe(409);
  });
});
