import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";
import { AlertingService } from "../alerts/alerting.service";
import { ActivityEntityType, DealStage, Role } from "@prisma/client";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ActivityLogService } from "../activity-log/activity-log.service";
import { AuthUserContext } from "../auth/auth.types";
import { decryptAppSecret } from "../marketplace/app-secret-crypto.util";
import { DealsService } from "../deals/deals.service";
import { NudgesService } from "../nudges/nudges.service";
import { PrismaService } from "../prisma/prisma.service";
import { WorkItemsService } from "../work-items/work-items.service";
import { AppCommand, CreateAppCommandDto } from "./dto/create-app-command.dto";

type CommandResult =
  | { workItemId?: string; nudgeId?: string; dealId?: string; stage?: DealStage }
  | Record<string, unknown>;

interface HandleAppCommandInput {
  orgId: string;
  appKey: string;
  signature: string;
  idempotencyKey: string;
  body: CreateAppCommandDto;
  rawBody?: Buffer;
  requestId?: string;
}

@Injectable()
export class AppCommandsService {
  private readonly rateState = new Map<string, { windowStartedAt: number; count: number }>();
  private static readonly RATE_LIMIT_PER_MINUTE = 60;

  constructor(
    private readonly prisma: PrismaService,
    private readonly nudgesService: NudgesService,
    private readonly workItemsService: WorkItemsService,
    private readonly dealsService: DealsService,
    private readonly activityLogService: ActivityLogService,
    private readonly alertingService: AlertingService
  ) {}

  async handleCommand(input: HandleAppCommandInput): Promise<{ ok: boolean; result: CommandResult; requestId?: string; idempotent?: boolean }> {
    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey) {
      throw new BadRequestException("Missing X-Idempotency-Key header");
    }

    const install = await this.prisma.orgAppInstall.findFirst({
      where: {
        orgId: input.orgId,
        status: "INSTALLED",
        app: {
          key: input.appKey
        }
      },
      include: {
        app: {
          select: {
            id: true,
            key: true,
            scopes: true
          }
        }
      }
    });

    if (!install || !install.secretEncrypted) {
      throw new UnauthorizedException({
        code: "APP_SIGNATURE_INVALID",
        message: "Invalid app signature"
      });
    }

    this.enforceRateLimit(install.id);

    const rawBody = input.rawBody ?? Buffer.from(JSON.stringify(input.body));
    const requestHash = createHash("sha256").update(rawBody).digest("hex");

    this.verifySignature(rawBody, input.signature, install.secretEncrypted);

    const existing = await this.prisma.appCommandLog.findUnique({
      where: {
        orgId_appInstallId_idempotencyKey: {
          orgId: install.orgId,
          appInstallId: install.id,
          idempotencyKey
        }
      }
    });

    if (existing) {
      return {
        ok: existing.success,
        result: this.parseResponseSnippet(existing.responseSnippet),
        requestId: input.requestId,
        idempotent: true
      };
    }

    this.assertScopeAllowed(install.app.scopes, input.body.command);
    const actor = await this.resolveActorContext(install.orgId, install.installedByUserId);

    let success = false;
    let statusCode = HttpStatus.OK;
    let errorMessage: string | null = null;
    let result: CommandResult = {};

    try {
      result = await this.executeCommand(input.body, actor);
      success = true;
    } catch (error) {
      const normalized = this.normalizeError(error);
      statusCode = normalized.statusCode;
      errorMessage = normalized.message;
    }

    const snippet = this.truncateSnippet(JSON.stringify({ ok: success, result, error: errorMessage }));
    await this.prisma.appCommandLog.create({
      data: {
        orgId: install.orgId,
        appInstallId: install.id,
        command: input.body.command,
        idempotencyKey,
        success,
        statusCode,
        error: errorMessage,
        requestHash,
        responseSnippet: snippet
      }
    });

    await this.activityLogService.log({
      orgId: install.orgId,
      actorUserId: actor.userId,
      entityType: ActivityEntityType.APP,
      entityId: install.id,
      action: "APP_COMMAND_EXECUTED",
      after: {
        appKey: install.app.key,
        command: input.body.command,
        idempotencyKey,
        success,
        statusCode
      }
    });

    if (!success) {
      await this.alertingService.recordFailure("APP_COMMAND_FAILURE_SPIKE", install.orgId, {
        appInstallId: install.id,
        command: input.body.command,
        reason: errorMessage ?? "App command failed"
      });
      throw new HttpException(
        {
          code: "APP_COMMAND_FAILED",
          message: errorMessage ?? "App command failed"
        },
        statusCode
      );
    }

    await this.prisma.orgAppInstall.update({
      where: { id: install.id },
      data: { lastUsedAt: new Date() }
    });

    return { ok: true, result, requestId: input.requestId };
  }

  private enforceRateLimit(installId: string): void {
    const now = Date.now();
    const state = this.rateState.get(installId);
    if (!state || now - state.windowStartedAt >= 60_000) {
      this.rateState.set(installId, { windowStartedAt: now, count: 1 });
      return;
    }

    const nextCount = state.count + 1;
    if (nextCount > AppCommandsService.RATE_LIMIT_PER_MINUTE) {
      throw new HttpException(
        {
          code: "APP_RATE_LIMITED",
          message: "App command rate limit exceeded"
        },
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
    state.count = nextCount;
    this.rateState.set(installId, state);
  }

  private verifySignature(rawBody: Buffer, signature: string, encryptedSecret: string): void {
    if (!signature) {
      throw new UnauthorizedException({
        code: "APP_SIGNATURE_INVALID",
        message: "Invalid app signature"
      });
    }

    const secret = decryptAppSecret(encryptedSecret);
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const left = Buffer.from(signature.trim(), "utf8");
    const right = Buffer.from(expected, "utf8");
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      throw new UnauthorizedException({
        code: "APP_SIGNATURE_INVALID",
        message: "Invalid app signature"
      });
    }
  }

  private assertScopeAllowed(scopes: unknown, command: AppCommand): void {
    const required = this.requiredScopeForCommand(command);
    const scopeValues = Array.isArray(scopes)
      ? scopes.filter((scope): scope is string => typeof scope === "string")
      : [];
    if (!scopeValues.includes(required)) {
      throw new ForbiddenException({
        code: "INSUFFICIENT_SCOPE",
        message: `Marketplace app scope '${required}' is required for command '${command}'.`
      });
    }
  }

  private requiredScopeForCommand(command: AppCommand): string {
    if (command === "create_nudge") {
      return "write:nudges";
    }
    if (command === "create_work_item") {
      return "write:work";
    }
    return "write:deals";
  }

  private async resolveActorContext(orgId: string, installedByUserId?: string | null): Promise<AuthUserContext> {
    const preferred = installedByUserId
      ? await this.prisma.user.findFirst({
          where: { id: installedByUserId, orgId, isActive: true },
          select: { id: true, orgId: true, role: true, email: true, name: true }
        })
      : null;

    const fallback =
      preferred ??
      (await this.prisma.user.findFirst({
        where: { orgId, isActive: true, role: { in: [Role.ADMIN, Role.CEO] } },
        orderBy: [{ createdAt: "asc" }],
        select: { id: true, orgId: true, role: true, email: true, name: true }
      })) ??
      (await this.prisma.user.findFirst({
        where: { orgId, isActive: true },
        orderBy: [{ createdAt: "asc" }],
        select: { id: true, orgId: true, role: true, email: true, name: true }
      }));

    if (!fallback) {
      throw new BadRequestException("No active user available for command execution");
    }

    return {
      userId: fallback.id,
      orgId: fallback.orgId,
      activeOrgId: fallback.orgId,
      role: fallback.role,
      email: fallback.email,
      name: fallback.name
    };
  }

  private async executeCommand(dto: CreateAppCommandDto, actor: AuthUserContext): Promise<CommandResult> {
    if (dto.command === "create_nudge") {
      const targetUserId = this.requiredString(dto.payload.targetUserId, "payload.targetUserId");
      const entityTypeInput = this.requiredString(dto.payload.entityType, "payload.entityType");
      const entityId = this.requiredString(dto.payload.entityId, "payload.entityId");
      const message = this.requiredString(dto.payload.message, "payload.message");

      if (!(entityTypeInput in ActivityEntityType)) {
        throw new BadRequestException("payload.entityType is invalid");
      }

      const created = await this.nudgesService.create(
        {
          targetUserId,
          entityType: entityTypeInput as ActivityEntityType,
          entityId,
          message
        },
        actor
      );

      return { nudgeId: created.id };
    }

    if (dto.command === "create_work_item") {
      const title = this.requiredString(dto.payload.title, "payload.title");
      const created = await this.workItemsService.create(
        {
          title,
          description: this.optionalString(dto.payload.description),
          status: dto.payload.status as never,
          priority: typeof dto.payload.priority === "number" ? dto.payload.priority : undefined,
          dueDate: this.optionalNullableString(dto.payload.dueDate),
          assignedToUserId: this.optionalNullableString(dto.payload.assignedToUserId),
          companyId: this.optionalNullableString(dto.payload.companyId),
          dealId: this.optionalNullableString(dto.payload.dealId)
        },
        actor
      );

      return { workItemId: created.id };
    }

    const dealId = this.requiredString(dto.payload.dealId, "payload.dealId");
    const stage = this.requiredString(dto.payload.stage, "payload.stage");
    if (!Object.values(DealStage).includes(stage as DealStage)) {
      throw new BadRequestException("payload.stage is invalid");
    }

    const updated = await this.dealsService.update(
      dealId,
      { stage: stage as DealStage },
      actor
    );
    return { dealId: updated.id, stage: updated.stage };
  }

  private requiredString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new BadRequestException(`${field} is required`);
    }
    return value.trim();
  }

  private optionalString(value: unknown): string | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "string") {
      throw new BadRequestException("Invalid payload field type");
    }
    return value.trim();
  }

  private optionalNullableString(value: unknown): string | null | undefined {
    if (value === null) {
      return null;
    }
    return this.optionalString(value);
  }

  private normalizeError(error: unknown): { statusCode: number; message: string } {
    if (error instanceof HttpException) {
      const statusCode = error.getStatus();
      const response = error.getResponse();
      if (typeof response === "string") {
        return { statusCode, message: response };
      }
      const message =
        typeof response === "object" && response && "message" in response
          ? Array.isArray((response as { message?: unknown }).message)
            ? ((response as { message?: unknown[] }).message ?? []).join(", ")
            : String((response as { message?: unknown }).message ?? "Request failed")
          : error.message;
      return { statusCode, message };
    }
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: error instanceof Error ? error.message : "Unexpected error"
    };
  }

  private parseResponseSnippet(snippet: string | null): CommandResult {
    if (!snippet) {
      return {};
    }
    try {
      const parsed = JSON.parse(snippet) as { result?: CommandResult };
      return parsed.result ?? {};
    } catch {
      return {};
    }
  }

  private truncateSnippet(value: string): string {
    const maxLength = 1024;
    if (value.length <= maxLength) {
      return value;
    }
    return value.slice(0, maxLength);
  }
}
