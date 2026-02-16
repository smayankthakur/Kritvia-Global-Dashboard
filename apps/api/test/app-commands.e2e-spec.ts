import { Role } from "@prisma/client";
import { createHmac } from "node:crypto";
import { encryptAppSecret } from "../src/marketplace/app-secret-crypto.util";
import { AppCommandsService } from "../src/public-api/app-commands.service";
import { CreateAppCommandDto } from "../src/public-api/dto/create-app-command.dto";

function signBody(secret: string, body: Buffer): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("AppCommandsService", () => {
  beforeEach(() => {
    process.env.APP_CONFIG_ENCRYPTION_KEY =
      process.env.APP_CONFIG_ENCRYPTION_KEY ||
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  });

  function createService(params?: {
    scopes?: string[];
    existingLog?: { success: boolean; responseSnippet: string | null };
  }) {
    const secret = "super-secret";
    const prisma = {
      orgAppInstall: {
        findFirst: jest.fn().mockResolvedValue({
          id: "install-1",
          orgId: "org-1",
          installedByUserId: "user-1",
          secretEncrypted: encryptAppSecret(secret),
          app: {
            id: "app-1",
            key: "slack",
            scopes: params?.scopes ?? ["write:nudges", "write:work", "write:deals"]
          }
        }),
        update: jest.fn().mockResolvedValue(undefined)
      },
      appCommandLog: {
        findUnique: jest.fn().mockResolvedValue(
          params?.existingLog
            ? {
                orgId: "org-1",
                appInstallId: "install-1",
                idempotencyKey: "idem-1",
                success: params.existingLog.success,
                responseSnippet: params.existingLog.responseSnippet
              }
            : null
        ),
        create: jest.fn().mockResolvedValue(undefined)
      },
      user: {
        findFirst: jest.fn().mockResolvedValue({
          id: "user-1",
          orgId: "org-1",
          role: Role.ADMIN,
          email: "admin@test.local",
          name: "Admin"
        })
      }
    };

    const nudgesService = {
      create: jest.fn().mockResolvedValue({ id: "nudge-1" })
    };
    const workItemsService = {
      create: jest.fn().mockResolvedValue({ id: "work-1" })
    };
    const dealsService = {
      update: jest.fn().mockResolvedValue({ id: "deal-1", stage: "WON" })
    };
    const activityLogService = {
      log: jest.fn().mockResolvedValue(undefined)
    };

    const service = new AppCommandsService(
      prisma as never,
      nudgesService as never,
      workItemsService as never,
      dealsService as never,
      activityLogService as never
    );

    return { service, prisma, nudgesService, workItemsService, secret };
  }

  it("accepts valid signature and executes create_nudge", async () => {
    const { service, nudgesService, prisma, secret } = createService();
    const body: CreateAppCommandDto = {
      command: "create_nudge",
      payload: {
        targetUserId: "target-1",
        entityType: "DEAL",
        entityId: "deal-1",
        message: "Follow up"
      }
    };
    const rawBody = Buffer.from(JSON.stringify(body));

    const response = await service.handleCommand({
      orgId: "org-1",
      appKey: "slack",
      signature: signBody(secret, rawBody),
      idempotencyKey: "idem-1",
      body,
      rawBody,
      requestId: "req-1"
    });

    expect(response.ok).toBe(true);
    expect(response.result).toEqual({ nudgeId: "nudge-1" });
    expect(nudgesService.create).toHaveBeenCalledTimes(1);
    expect(prisma.appCommandLog.create).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid signature", async () => {
    const { service } = createService();
    const body: CreateAppCommandDto = {
      command: "create_nudge",
      payload: {
        targetUserId: "target-1",
        entityType: "DEAL",
        entityId: "deal-1",
        message: "Follow up"
      }
    };
    const rawBody = Buffer.from(JSON.stringify(body));

    await expect(
      service.handleCommand({
        orgId: "org-1",
        appKey: "slack",
        signature: "invalid",
        idempotencyKey: "idem-1",
        body,
        rawBody
      })
    ).rejects.toMatchObject({
      status: 401
    });
  });

  it("returns cached idempotent result on replay", async () => {
    const { service } = createService({
      existingLog: {
        success: true,
        responseSnippet: JSON.stringify({ ok: true, result: { nudgeId: "nudge-1" } })
      }
    });
    const body: CreateAppCommandDto = {
      command: "create_nudge",
      payload: {
        targetUserId: "target-1",
        entityType: "DEAL",
        entityId: "deal-1",
        message: "Follow up"
      }
    };
    const rawBody = Buffer.from(JSON.stringify(body));

    const response = await service.handleCommand({
      orgId: "org-1",
      appKey: "slack",
      signature: signBody("super-secret", rawBody),
      idempotencyKey: "idem-1",
      body,
      rawBody
    });

    expect(response.ok).toBe(true);
    expect(response.idempotent).toBe(true);
    expect(response.result).toEqual({ nudgeId: "nudge-1" });
  });

  it("blocks commands when required scope is missing", async () => {
    const { service, secret } = createService({ scopes: ["read:deals"] });
    const body: CreateAppCommandDto = {
      command: "create_work_item",
      payload: {
        title: "Do work"
      }
    };
    const rawBody = Buffer.from(JSON.stringify(body));

    await expect(
      service.handleCommand({
        orgId: "org-1",
        appKey: "slack",
        signature: signBody(secret, rawBody),
        idempotencyKey: "idem-2",
        body,
        rawBody
      })
    ).rejects.toMatchObject({
      status: 403
    });
  });

  it("executes create_work_item command", async () => {
    const { service, workItemsService, secret } = createService();
    const body: CreateAppCommandDto = {
      command: "create_work_item",
      payload: {
        title: "Ship dashboard",
        priority: 2
      }
    };
    const rawBody = Buffer.from(JSON.stringify(body));

    const response = await service.handleCommand({
      orgId: "org-1",
      appKey: "slack",
      signature: signBody(secret, rawBody),
      idempotencyKey: "idem-work",
      body,
      rawBody
    });

    expect(response.ok).toBe(true);
    expect(response.result).toEqual({ workItemId: "work-1" });
    expect(workItemsService.create).toHaveBeenCalledTimes(1);
  });
});
