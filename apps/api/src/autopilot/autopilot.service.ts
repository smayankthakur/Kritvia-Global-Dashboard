import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException
} from "@nestjs/common";
import { ActivityEntityType, Prisma, Role } from "@prisma/client";
import { ActivityLogService } from "../activity-log/activity-log.service";
import { AuthUserContext } from "../auth/auth.types";
import { getActiveOrgId } from "../common/auth-org";
import { toPaginatedResponse } from "../common/dto/paginated-response.dto";
import { isFeatureEnabled } from "../common/feature-flags";
import { FixActionsService } from "../fix-actions/fix-actions.service";
import { PolicyResolverService } from "../policy/policy-resolver.service";
import { PrismaService } from "../prisma/prisma.service";
import { RiskDriver } from "../graph/risk/risk-engine.service";
import { CreateAutopilotPolicyDto } from "./dto/create-policy.dto";
import { UpdateAutopilotPolicyDto } from "./dto/update-policy.dto";

type SupportedEntityType = "INVOICE" | "WORK_ITEM" | "INCIDENT";

type ConditionOperator = "gt" | "gte" | "lt" | "lte" | "eq" | "in";

type ConditionExpression = {
  field?: "riskScore" | "dueAtPastDays" | "amountCents" | "status";
  op?: ConditionOperator;
  value?: unknown;
};

@Injectable()
export class AutopilotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policyResolverService: PolicyResolverService,
    private readonly fixActionsService: FixActionsService,
    private readonly activityLogService: ActivityLogService
  ) {}

  async listPolicies(authUser: AuthUserContext) {
    const orgId = getActiveOrgId({ user: authUser });
    return this.prisma.autopilotPolicy.findMany({
      where: { orgId },
      orderBy: [{ createdAt: "desc" }]
    });
  }

  async createPolicy(authUser: AuthUserContext, dto: CreateAutopilotPolicyDto) {
    this.assertAutopilotFeatureEnabled();
    const orgId = getActiveOrgId({ user: authUser });
    await this.assertTemplateExists(orgId, dto.actionTemplateKey);

    const policy = await this.prisma.autopilotPolicy.create({
      data: {
        orgId,
        name: dto.name,
        isEnabled: dto.isEnabled ?? true,
        entityType: dto.entityType,
        condition: dto.condition as Prisma.InputJsonValue,
        actionTemplateKey: dto.actionTemplateKey,
        riskThreshold: dto.riskThreshold,
        autoExecute: dto.autoExecute ?? false,
        maxExecutionsPerHour: dto.maxExecutionsPerHour ?? 10
      }
    });

    await this.activityLogService.log({
      orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.POLICY,
      entityId: policy.id,
      action: "AUTOPILOT_POLICY_CREATED",
      after: policy
    });

    return policy;
  }

  async updatePolicy(authUser: AuthUserContext, id: string, dto: UpdateAutopilotPolicyDto) {
    this.assertAutopilotFeatureEnabled();
    const orgId = getActiveOrgId({ user: authUser });
    const existing = await this.prisma.autopilotPolicy.findFirst({ where: { id, orgId } });
    if (!existing) {
      throw new NotFoundException("Autopilot policy not found");
    }

    if (dto.actionTemplateKey) {
      await this.assertTemplateExists(orgId, dto.actionTemplateKey);
    }

    const updated = await this.prisma.autopilotPolicy.update({
      where: { id: existing.id },
      data: {
        name: dto.name,
        isEnabled: dto.isEnabled,
        entityType: dto.entityType,
        condition: dto.condition ? (dto.condition as Prisma.InputJsonValue) : undefined,
        actionTemplateKey: dto.actionTemplateKey,
        riskThreshold: dto.riskThreshold,
        autoExecute: dto.autoExecute,
        maxExecutionsPerHour: dto.maxExecutionsPerHour
      }
    });

    await this.activityLogService.log({
      orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.POLICY,
      entityId: updated.id,
      action: "AUTOPILOT_POLICY_UPDATED",
      before: existing,
      after: updated
    });

    return updated;
  }

  async deletePolicy(authUser: AuthUserContext, id: string) {
    this.assertAutopilotFeatureEnabled();
    const orgId = getActiveOrgId({ user: authUser });
    const existing = await this.prisma.autopilotPolicy.findFirst({ where: { id, orgId } });
    if (!existing) {
      throw new NotFoundException("Autopilot policy not found");
    }

    await this.prisma.autopilotPolicy.delete({ where: { id: existing.id } });
    await this.activityLogService.log({
      orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.POLICY,
      entityId: existing.id,
      action: "AUTOPILOT_POLICY_DELETED",
      before: existing
    });

    return { success: true };
  }

  async listRuns(
    authUser: AuthUserContext,
    query: { entityType?: string; status?: string; page: number; pageSize: number }
  ) {
    const orgId = getActiveOrgId({ user: authUser });
    const where: Prisma.AutopilotRunWhereInput = {
      orgId,
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.status ? { status: query.status } : {})
    };

    const skip = (query.page - 1) * query.pageSize;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.autopilotRun.findMany({
        where,
        include: {
          policy: {
            select: {
              id: true,
              name: true,
              actionTemplateKey: true,
              autoExecute: true
            }
          },
          fixActionRun: {
            select: {
              id: true,
              status: true,
              error: true,
              createdAt: true
            }
          }
        },
        orderBy: [{ createdAt: "desc" }],
        skip,
        take: query.pageSize
      }),
      this.prisma.autopilotRun.count({ where })
    ]);

    return toPaginatedResponse(items, query.page, query.pageSize, total);
  }

  async approveRun(authUser: AuthUserContext, runId: string) {
    const orgId = getActiveOrgId({ user: authUser });

    const run = await this.prisma.autopilotRun.findFirst({
      where: {
        id: runId,
        orgId
      },
      include: { policy: true }
    });

    if (!run) {
      throw new NotFoundException("Autopilot run not found");
    }

    if (this.isKillSwitchEnabled()) {
      await this.activityLogService.log({
        orgId,
        actorUserId: authUser.userId,
        entityType: ActivityEntityType.POLICY,
        entityId: run.policyId,
        action: "AUTOPILOT_SKIPPED",
        after: {
          autopilotRunId: run.id,
          reason: "KILL_SWITCH_AUTOPILOT"
        }
      });
      throw new ServiceUnavailableException("Autopilot execution blocked by kill switch.");
    }

    if (run.status !== "APPROVAL_REQUIRED") {
      throw new ConflictException(`Run is in status ${run.status}`);
    }

    if (!run.fixActionRunId) {
      throw new ConflictException("Run has no fix action to approve");
    }

    const result = await this.fixActionsService.confirmRun(authUser, run.fixActionRunId, true);

    const updated = await this.prisma.autopilotRun.update({
      where: { id: run.id },
      data: {
        status: "EXECUTED",
        result: {
          approvedByUserId: authUser.userId,
          approvedAt: new Date().toISOString(),
          fixActionRunId: result.id,
          fixActionStatus: result.status
        } as Prisma.InputJsonValue,
        error: null
      }
    });

    await this.activityLogService.log({
      orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.POLICY,
      entityId: run.policyId,
      action: "AUTOPILOT_EXECUTED",
      after: {
        autopilotRunId: run.id,
        fixActionRunId: run.fixActionRunId
      }
    });

    return updated;
  }

  async rollbackRun(authUser: AuthUserContext, runId: string) {
    const orgId = getActiveOrgId({ user: authUser });
    const run = await this.prisma.autopilotRun.findFirst({
      where: { id: runId, orgId },
      include: { policy: true }
    });

    if (!run) {
      throw new NotFoundException("Autopilot run not found");
    }

    if (run.status !== "EXECUTED") {
      throw new ConflictException("Only executed runs can be rolled back");
    }

    const preview = this.asObject(run.preview);
    const result = this.asObject(run.result);

    if (run.policy.actionTemplateKey === "SET_DUE_DATE") {
      const previousDueAt = this.getNullableString(preview, "previousDueAt");
      const targetDueAt = previousDueAt ? new Date(previousDueAt) : null;

      if (run.entityType === "WORK_ITEM") {
        await this.prisma.workItem.update({ where: { id: run.entityId }, data: { dueDate: targetDueAt } });
      } else if (run.entityType === "INVOICE") {
        if (!targetDueAt) {
          throw new BadRequestException("Cannot rollback invoice due date without previousDueAt");
        }
        await this.prisma.invoice.update({ where: { id: run.entityId }, data: { dueDate: targetDueAt } });
      } else {
        throw new BadRequestException("SET_DUE_DATE rollback not supported for this entity type");
      }
    } else if (run.policy.actionTemplateKey === "REASSIGN_WORK") {
      const previousAssignee = this.getNullableString(preview, "previousAssigneeUserId");
      await this.prisma.workItem.update({
        where: { id: run.entityId },
        data: { assignedToUserId: previousAssignee }
      });
    } else {
      throw new BadRequestException("Rollback supported only for SET_DUE_DATE and REASSIGN_WORK");
    }

    const updated = await this.prisma.autopilotRun.update({
      where: { id: run.id },
      data: {
        result: {
          ...result,
          rolledBackByUserId: authUser.userId,
          rolledBackAt: new Date().toISOString()
        } as Prisma.InputJsonValue
      }
    });

    await this.activityLogService.log({
      orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.POLICY,
      entityId: run.policyId,
      action: "AUTOPILOT_ROLLBACK",
      after: {
        autopilotRunId: run.id,
        actionTemplateKey: run.policy.actionTemplateKey
      }
    });

    return updated;
  }

  async evaluateAndExecute(orgId: string, driver: RiskDriver) {
    if (!this.isAutopilotEnabled()) {
      return [];
    }

    const orgPolicy = await this.policyResolverService.getPolicyForOrg(orgId);
    if (!orgPolicy.autopilotEnabled) {
      return [];
    }

    const entityType = this.mapDriverEntityType(driver);
    if (!entityType) {
      return [];
    }

    const actor = await this.resolveAutopilotActor(orgId);
    if (!actor) {
      return [];
    }

    const policies = await this.prisma.autopilotPolicy.findMany({
      where: {
        orgId,
        isEnabled: true,
        entityType
      },
      orderBy: [{ createdAt: "asc" }]
    });

    const outcomes: Array<{ policyId: string; status: string; runId?: string }> = [];

    for (const policy of policies) {
      const run = await this.prisma.autopilotRun.create({
        data: {
          orgId,
          policyId: policy.id,
          entityType,
          entityId: driver.entityId,
          status: "DRY_RUN"
        }
      });

      try {
        const context = this.buildContext(driver);
        const conditionMatches = this.evaluateCondition(policy.condition, context);
        if (!conditionMatches) {
          await this.skipWithLog(actor.userId, policy.id, run.id, "Condition did not match");
          outcomes.push({ policyId: policy.id, status: "SKIPPED", runId: run.id });
          continue;
        }

        if (typeof policy.riskThreshold === "number" && driver.riskScore < policy.riskThreshold) {
          await this.skipWithLog(
            actor.userId,
            policy.id,
            run.id,
            `riskScore below threshold ${policy.riskThreshold}`
          );
          outcomes.push({ policyId: policy.id, status: "SKIPPED", runId: run.id });
          continue;
        }

        const previewInput = await this.buildActionInput(orgId, policy.actionTemplateKey, driver);
        const preview = await this.fixActionsService.previewRun(actor, {
          templateKey: policy.actionTemplateKey,
          entityType,
          entityId: driver.entityId,
          input: previewInput
        });

        await this.prisma.autopilotRun.update({
          where: { id: run.id },
          data: {
            preview: preview as Prisma.InputJsonValue
          }
        });

        const executionCount = await this.prisma.autopilotRun.count({
          where: {
            policyId: policy.id,
            status: "EXECUTED",
            createdAt: {
              gte: new Date(Date.now() - 60 * 60 * 1000)
            }
          }
        });

        if (executionCount >= policy.maxExecutionsPerHour) {
          await this.skipWithLog(
            actor.userId,
            policy.id,
            run.id,
            "Policy maxExecutionsPerHour reached"
          );
          outcomes.push({ policyId: policy.id, status: "SKIPPED", runId: run.id });
          continue;
        }

        const requiresApproval = this.requiresApproval(driver.riskScore, policy.autoExecute);
        const fixActionRun = await this.fixActionsService.createRun(
          actor,
          {
            templateKey: policy.actionTemplateKey as "SEND_INVOICE_REMINDER" | "REASSIGN_WORK" | "SET_DUE_DATE" | "ESCALATE_INCIDENT",
            entityType,
            entityId: driver.entityId,
            input: previewInput
          },
          {
            forcePending: requiresApproval,
            skipAutoExecute: requiresApproval
          }
        );

        await this.prisma.autopilotRun.update({
          where: { id: run.id },
          data: {
            fixActionRunId: fixActionRun.id
          }
        });

        await this.activityLogService.log({
          orgId,
          actorUserId: actor.userId,
          entityType: ActivityEntityType.POLICY,
          entityId: policy.id,
          action: "AUTOPILOT_TRIGGERED",
          after: {
            autopilotRunId: run.id,
            fixActionRunId: fixActionRun.id,
            entityType,
            entityId: driver.entityId
          }
        });

        if (requiresApproval) {
          await this.prisma.autopilotRun.update({
            where: { id: run.id },
            data: {
              status: "APPROVAL_REQUIRED"
            }
          });
          await this.activityLogService.log({
            orgId,
            actorUserId: actor.userId,
            entityType: ActivityEntityType.POLICY,
            entityId: policy.id,
            action: "AUTOPILOT_APPROVAL_REQUIRED",
            after: {
              autopilotRunId: run.id,
              riskScore: driver.riskScore
            }
          });
          outcomes.push({ policyId: policy.id, status: "APPROVAL_REQUIRED", runId: run.id });
          continue;
        }

        if (this.isKillSwitchEnabled()) {
          await this.skipWithLog(actor.userId, policy.id, run.id, "KILL_SWITCH_AUTOPILOT");
          outcomes.push({ policyId: policy.id, status: "SKIPPED", runId: run.id });
          continue;
        }

        const executedFix = await this.fixActionsService.confirmRun(actor, fixActionRun.id, true);
        await this.prisma.autopilotRun.update({
          where: { id: run.id },
          data: {
            status: "EXECUTED",
            result: {
              fixActionRunId: executedFix.id,
              fixActionStatus: executedFix.status
            } as Prisma.InputJsonValue,
            error: null
          }
        });

        await this.activityLogService.log({
          orgId,
          actorUserId: actor.userId,
          entityType: ActivityEntityType.POLICY,
          entityId: policy.id,
          action: "AUTOPILOT_EXECUTED",
          after: {
            autopilotRunId: run.id,
            fixActionRunId: fixActionRun.id
          }
        });

        outcomes.push({ policyId: policy.id, status: "EXECUTED", runId: run.id });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Autopilot execution failed";
        await this.prisma.autopilotRun.update({
          where: { id: run.id },
          data: {
            status: "FAILED",
            error: message
          }
        });

        await this.activityLogService.log({
          orgId,
          actorUserId: actor.userId,
          entityType: ActivityEntityType.POLICY,
          entityId: policy.id,
          action: "AUTOPILOT_SKIPPED",
          after: {
            autopilotRunId: run.id,
            error: message
          }
        });

        outcomes.push({ policyId: policy.id, status: "FAILED", runId: run.id });
      }
    }

    return outcomes;
  }

  private async markRunSkipped(runId: string, reason: string) {
    await this.prisma.autopilotRun.update({
      where: { id: runId },
      data: {
        status: "SKIPPED",
        error: reason
      }
    });
  }

  private async skipWithLog(
    actorUserId: string,
    policyId: string,
    runId: string,
    reason: string
  ): Promise<void> {
    const run = await this.prisma.autopilotRun.findUnique({
      where: { id: runId },
      select: { orgId: true }
    });
    await this.markRunSkipped(runId, reason);
    if (!run) {
      return;
    }
    await this.activityLogService.log({
      orgId: run.orgId,
      actorUserId,
      entityType: ActivityEntityType.POLICY,
      entityId: policyId,
      action: "AUTOPILOT_SKIPPED",
      after: { autopilotRunId: runId, reason }
    });
  }

  private evaluateCondition(condition: Prisma.JsonValue, context: Record<string, unknown>): boolean {
    if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
      return true;
    }

    const expression = condition as ConditionExpression;
    if (!expression.field || !expression.op) {
      return true;
    }

    const actual = context[expression.field];
    const expected = expression.value;

    switch (expression.op) {
      case "gt":
        return this.toNumber(actual) > this.toNumber(expected);
      case "gte":
        return this.toNumber(actual) >= this.toNumber(expected);
      case "lt":
        return this.toNumber(actual) < this.toNumber(expected);
      case "lte":
        return this.toNumber(actual) <= this.toNumber(expected);
      case "eq":
        return String(actual ?? "") === String(expected ?? "");
      case "in":
        return Array.isArray(expected) ? expected.map((item) => String(item)).includes(String(actual ?? "")) : false;
      default:
        return false;
    }
  }

  private buildContext(driver: RiskDriver): Record<string, unknown> {
    const dueAt = driver.evidence.dueAt ? new Date(driver.evidence.dueAt) : null;
    const now = Date.now();
    const dueAtPastDays =
      dueAt && !Number.isNaN(dueAt.getTime()) && dueAt.getTime() < now
        ? Math.floor((now - dueAt.getTime()) / (24 * 60 * 60 * 1000))
        : 0;

    return {
      riskScore: driver.riskScore,
      dueAtPastDays,
      amountCents: driver.evidence.amountCents ?? 0,
      status: driver.evidence.status ?? ""
    };
  }

  private mapDriverEntityType(driver: RiskDriver): SupportedEntityType | null {
    if (driver.type === "INVOICE") {
      return "INVOICE";
    }
    if (driver.type === "WORK_ITEM") {
      return "WORK_ITEM";
    }
    if (driver.type === "INCIDENT") {
      return "INCIDENT";
    }
    return null;
  }

  private async buildActionInput(
    orgId: string,
    actionTemplateKey: string,
    driver: RiskDriver
  ): Promise<Record<string, unknown>> {
    if (actionTemplateKey === "SET_DUE_DATE") {
      const dueAt = new Date();
      dueAt.setUTCDate(dueAt.getUTCDate() + 2);
      return {
        dueAt: dueAt.toISOString(),
        reason: "Autopilot risk mitigation"
      };
    }

    if (actionTemplateKey === "REASSIGN_WORK") {
      const assignee = await this.prisma.user.findFirst({
        where: {
          orgId,
          isActive: true,
          role: { in: [Role.OPS, Role.ADMIN, Role.CEO] }
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true }
      });
      return {
        assigneeUserId: this.getStringFromDriver(driver, "assigneeUserId") || assignee?.id || "",
        reason: "Autopilot risk reassignment"
      };
    }

    return {
      reason: "Autopilot trigger"
    };
  }

  private getStringFromDriver(driver: RiskDriver, key: string): string {
    const meta = (driver as unknown as { meta?: Record<string, unknown> }).meta;
    const value = meta?.[key];
    return typeof value === "string" ? value : "";
  }

  private async assertTemplateExists(orgId: string, templateKey: string): Promise<void> {
    const template = await this.prisma.fixActionTemplate.findFirst({
      where: {
        orgId,
        key: templateKey,
        isEnabled: true
      },
      select: { id: true }
    });

    if (!template) {
      throw new BadRequestException("actionTemplateKey must map to an enabled FixActionTemplate in this org");
    }
  }

  private requiresApproval(riskScore: number, autoExecute: boolean): boolean {
    if (riskScore >= 85) {
      return true;
    }
    if (riskScore >= 70 && riskScore <= 84) {
      return !autoExecute;
    }
    return !autoExecute;
  }

  private async resolveAutopilotActor(orgId: string): Promise<AuthUserContext | null> {
    const user = await this.prisma.user.findFirst({
      where: {
        orgId,
        isActive: true,
        role: {
          in: [Role.ADMIN, Role.CEO, Role.OPS]
        }
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }]
    });

    if (!user) {
      return null;
    }

    return {
      userId: user.id,
      orgId,
      activeOrgId: orgId,
      role: user.role,
      email: user.email,
      name: user.name
    };
  }

  private assertAutopilotFeatureEnabled(): void {
    if (!this.isAutopilotEnabled()) {
      throw new ServiceUnavailableException("Autopilot is disabled.");
    }
  }

  private isAutopilotEnabled(): boolean {
    return isFeatureEnabled("FEATURE_AUTOPILOT_ENABLED") || isFeatureEnabled("FEATURE_AUTOPILOT");
  }

  private isKillSwitchEnabled(): boolean {
    const value = (process.env.KILL_SWITCH_AUTOPILOT ?? "false").toLowerCase();
    return value === "true" || value === "1";
  }

  private toNumber(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private asObject(value: Prisma.JsonValue | null): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    return value as Record<string, unknown>;
  }

  private getNullableString(source: Record<string, unknown>, key: string): string | null {
    const value = source[key];
    if (value === null) {
      return null;
    }
    return typeof value === "string" ? value : null;
  }
}
