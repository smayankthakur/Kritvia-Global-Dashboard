import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException
} from "@nestjs/common";
import {
  ActivityEntityType,
  FixActionRun,
  InvoiceStatus,
  NudgeStatus,
  Prisma,
  Role
} from "@prisma/client";
import { createHash } from "node:crypto";
import { ActivityLogService } from "../activity-log/activity-log.service";
import { AuthUserContext } from "../auth/auth.types";
import { getActiveOrgId } from "../common/auth-org";
import { toPaginatedResponse } from "../common/dto/paginated-response.dto";
import { isFeatureEnabled } from "../common/feature-flags";
import { PrismaService } from "../prisma/prisma.service";
import { CreateFixActionRunDto } from "./dto/create-run.dto";

type FixActionStatus = "PENDING" | "CONFIRMED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

type TemplateKey =
  | "SEND_INVOICE_REMINDER"
  | "REASSIGN_WORK"
  | "SET_DUE_DATE"
  | "ESCALATE_INCIDENT";

type RunResult = Record<string, unknown>;
type ExecutionMode = { dryRun: boolean };

type TemplateLike = {
  id: string;
  key: string;
  title: string;
  description: string | null;
  requiresConfirmation: boolean;
  allowedRoles: Prisma.JsonValue;
  config: Prisma.JsonValue;
  isEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class FixActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLogService: ActivityLogService
  ) {}

  async listTemplates(authUser: AuthUserContext) {
    this.assertFeatureEnabled();
    const orgId = getActiveOrgId({ user: authUser });

    return this.prisma.fixActionTemplate.findMany({
      where: {
        orgId,
        isEnabled: true
      },
      orderBy: [{ key: "asc" }]
    });
  }

  async createRun(
    authUser: AuthUserContext,
    dto: CreateFixActionRunDto,
    options?: { forcePending?: boolean; skipAutoExecute?: boolean }
  ) {
    this.assertFeatureEnabled();
    const orgId = getActiveOrgId({ user: authUser });
    await this.assertRateLimit(orgId);

    const template = await this.prisma.fixActionTemplate.findFirst({
      where: {
        orgId,
        key: dto.templateKey,
        isEnabled: true
      }
    });

    if (!template) {
      throw new NotFoundException("Fix action template not found");
    }

    this.assertRoleAllowed(authUser.role, template);
    this.assertTemplateEntityMatch(template.key as TemplateKey, dto.entityType);
    await this.assertEntityInOrg(orgId, dto.entityType, dto.entityId);

    if (dto.nudgeId) {
      const nudge = await this.prisma.nudge.findFirst({
        where: {
          id: dto.nudgeId,
          orgId
        },
        select: { id: true }
      });
      if (!nudge) {
        throw new NotFoundException("Nudge not found");
      }
    }

    const idempotencyKey =
      dto.idempotencyKey ??
      this.buildIdempotencyKey(orgId, template.key, dto.entityType, dto.entityId, dto.input);

    const existing = await this.prisma.fixActionRun.findFirst({
      where: {
        orgId,
        idempotencyKey
      }
    });

    if (existing) {
      return {
        id: existing.id,
        status: existing.status,
        requiresConfirmation: template.requiresConfirmation,
        idempotencyKey: existing.idempotencyKey
      };
    }

    const initialStatus: FixActionStatus =
      options?.forcePending || template.requiresConfirmation ? "PENDING" : "CONFIRMED";
    const created = await this.prisma.fixActionRun.create({
      data: {
        orgId,
        templateId: template.id,
        nudgeId: dto.nudgeId,
        entityType: dto.entityType,
        entityId: dto.entityId,
        requestedByUserId: authUser.userId,
        status: initialStatus,
        idempotencyKey,
        input: dto.input ? (dto.input as Prisma.InputJsonValue) : Prisma.JsonNull
      }
    });

    await this.activityLogService.log({
      orgId,
      actorUserId: authUser.userId,
      entityType: this.toActivityEntityType(dto.entityType),
      entityId: dto.entityId,
      action: "FIX_ACTION_RUN_CREATED",
      after: {
        runId: created.id,
        templateKey: template.key,
        status: created.status
      }
    });

    if (!template.requiresConfirmation && !options?.skipAutoExecute && !options?.forcePending) {
      await this.executeRunInternal(created.id, authUser, true);
      const executed = await this.prisma.fixActionRun.findUnique({ where: { id: created.id } });
      return {
        id: created.id,
        status: executed?.status ?? created.status,
        requiresConfirmation: false,
        idempotencyKey
      };
    }

    return {
      id: created.id,
      status: created.status,
      requiresConfirmation: template.requiresConfirmation,
      idempotencyKey
    };
  }

  async confirmRun(authUser: AuthUserContext, runId: string, confirm: boolean) {
    this.assertFeatureEnabled();
    if (!confirm) {
      throw new BadRequestException("confirm must be true");
    }

    const orgId = getActiveOrgId({ user: authUser });
    const run = await this.prisma.fixActionRun.findFirst({
      where: { id: runId, orgId },
      include: {
        template: true
      }
    });

    if (!run) {
      throw new NotFoundException("Fix action run not found");
    }

    if (run.requestedByUserId !== authUser.userId && authUser.role !== Role.ADMIN && authUser.role !== Role.CEO) {
      throw new ForbiddenException("Only requester or CEO/ADMIN can confirm");
    }

    if (run.status === "SUCCEEDED") {
      return run;
    }

    if (run.status !== "PENDING") {
      throw new ConflictException(`Cannot confirm run in status ${run.status}`);
    }

    await this.prisma.fixActionRun.update({
      where: { id: run.id },
      data: {
        status: "CONFIRMED"
      }
    });

    await this.activityLogService.log({
      orgId,
      actorUserId: authUser.userId,
      entityType: this.toActivityEntityType(run.entityType),
      entityId: run.entityId,
      action: "FIX_ACTION_RUN_CONFIRMED",
      after: {
        runId: run.id,
        templateKey: run.template.key
      }
    });

    return this.executeRunInternal(run.id, authUser, false);
  }

  async executeRunById(authUser: AuthUserContext, runId: string) {
    this.assertFeatureEnabled();
    const run = await this.prisma.fixActionRun.findFirst({
      where: {
        id: runId,
        orgId: getActiveOrgId({ user: authUser })
      },
      select: { id: true }
    });
    if (!run) {
      throw new NotFoundException("Fix action run not found");
    }
    return this.executeRunInternal(runId, authUser, false);
  }

  async previewRun(
    authUser: AuthUserContext,
    dto: Pick<CreateFixActionRunDto, "templateKey" | "entityType" | "entityId" | "input">
  ): Promise<RunResult> {
    this.assertFeatureEnabled();
    const orgId = getActiveOrgId({ user: authUser });
    const template = await this.prisma.fixActionTemplate.findFirst({
      where: { orgId, key: dto.templateKey, isEnabled: true }
    });
    if (!template) {
      throw new NotFoundException("Fix action template not found");
    }
    this.assertRoleAllowed(authUser.role, template);
    this.assertTemplateEntityMatch(template.key as TemplateKey, dto.entityType);
    await this.assertEntityInOrg(orgId, dto.entityType, dto.entityId);

    const fakeRun = {
      id: "preview",
      orgId,
      templateId: template.id,
      nudgeId: null,
      entityType: dto.entityType,
      entityId: dto.entityId,
      requestedByUserId: authUser.userId,
      status: "RUNNING",
      idempotencyKey: "preview",
      input: (dto.input ?? {}) as Prisma.JsonValue,
      result: null,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      template
    } as unknown as FixActionRun & { template: TemplateLike };

    return this.executeTemplate(fakeRun, authUser, { dryRun: true });
  }

  async listRuns(
    authUser: AuthUserContext,
    query: {
      entityType?: string;
      entityId?: string;
      status?: string;
      page: number;
      pageSize: number;
    }
  ) {
    this.assertFeatureEnabled();
    const orgId = getActiveOrgId({ user: authUser });

    const where: Prisma.FixActionRunWhereInput = {
      orgId,
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.status ? { status: query.status } : {})
    };

    const skip = (query.page - 1) * query.pageSize;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.fixActionRun.findMany({
        where,
        include: {
          template: {
            select: {
              id: true,
              key: true,
              title: true,
              requiresConfirmation: true
            }
          },
          requestedByUser: {
            select: { id: true, name: true, email: true, role: true }
          }
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take: query.pageSize
      }),
      this.prisma.fixActionRun.count({ where })
    ]);

    return toPaginatedResponse(items, query.page, query.pageSize, total);
  }

  private async executeRunInternal(runId: string, authUser: AuthUserContext, bypassConfirmation: boolean) {
    if (!isFeatureEnabled("FEATURE_FIX_ACTIONS_EXECUTION")) {
      await this.prisma.fixActionRun.update({
        where: { id: runId },
        data: {
          status: "FAILED",
          error: "Execution disabled by FEATURE_FIX_ACTIONS_EXECUTION"
        }
      });
      throw new ServiceUnavailableException("Fix action execution is disabled.");
    }

    const run = await this.prisma.fixActionRun.findUnique({
      where: { id: runId },
      include: {
        template: true
      }
    });

    if (!run) {
      throw new NotFoundException("Fix action run not found");
    }

    const allowedStatuses = bypassConfirmation ? ["CONFIRMED", "RUNNING", "SUCCEEDED"] : ["CONFIRMED"];
    if (!allowedStatuses.includes(run.status)) {
      if (run.status === "SUCCEEDED") {
        return run;
      }
      throw new ConflictException(`Cannot execute run in status ${run.status}`);
    }

    const existingSuccess = await this.prisma.fixActionRun.findFirst({
      where: {
        orgId: run.orgId,
        idempotencyKey: run.idempotencyKey,
        status: "SUCCEEDED"
      }
    });
    if (existingSuccess) {
      return existingSuccess;
    }

    await this.prisma.fixActionRun.update({
      where: { id: run.id },
      data: {
        status: "RUNNING",
        error: null
      }
    });

    try {
      const result = await this.executeTemplate(run, authUser);
      const updated = await this.prisma.fixActionRun.update({
        where: { id: run.id },
        data: {
          status: "SUCCEEDED",
          result: result as Prisma.InputJsonValue,
          error: null
        }
      });

      await this.activityLogService.log({
        orgId: run.orgId,
        actorUserId: authUser.userId,
        entityType: this.toActivityEntityType(run.entityType),
        entityId: run.entityId,
        action: "FIX_ACTION_RUN_SUCCEEDED",
        after: {
          runId: run.id,
          templateKey: run.template.key,
          result
        }
      });

      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Fix action execution failed";
      await this.prisma.fixActionRun.update({
        where: { id: run.id },
        data: {
          status: "FAILED",
          error: message
        }
      });

      await this.activityLogService.log({
        orgId: run.orgId,
        actorUserId: authUser.userId,
        entityType: this.toActivityEntityType(run.entityType),
        entityId: run.entityId,
        action: "FIX_ACTION_RUN_FAILED",
        after: {
          runId: run.id,
          templateKey: run.template.key,
          error: message
        }
      });

      throw error;
    }
  }

  private async executeTemplate(
    run: FixActionRun & { template: TemplateLike },
    authUser: AuthUserContext,
    mode: ExecutionMode = { dryRun: false }
  ): Promise<RunResult> {
    const key = run.template.key as TemplateKey;

    switch (key) {
      case "SEND_INVOICE_REMINDER":
        return this.executeSendInvoiceReminder(run, authUser.userId, mode);
      case "REASSIGN_WORK":
        return this.executeReassignWork(run, authUser.userId, mode);
      case "SET_DUE_DATE":
        return this.executeSetDueDate(run, authUser, mode);
      case "ESCALATE_INCIDENT":
        return this.executeEscalateIncident(run, authUser.userId, mode);
      default:
        throw new BadRequestException(`Unsupported fix action template key: ${run.template.key}`);
    }
  }

  private async executeSendInvoiceReminder(
    run: FixActionRun & { template: TemplateLike },
    actorUserId: string,
    mode: ExecutionMode
  ): Promise<RunResult> {
    const invoice = await this.prisma.invoice.findFirst({
      where: {
        id: run.entityId,
        orgId: run.orgId
      },
      include: {
        company: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    if (!invoice) {
      throw new NotFoundException("Invoice not found");
    }

    if (invoice.status === InvoiceStatus.PAID) {
      throw new ConflictException("Invoice already paid");
    }

    const recentReminder = await this.prisma.fixActionRun.findFirst({
      where: {
        orgId: run.orgId,
        templateId: run.templateId,
        entityType: "INVOICE",
        entityId: run.entityId,
        status: "SUCCEEDED",
        createdAt: {
          gte: new Date(Date.now() - 60 * 60 * 1000)
        }
      },
      orderBy: [{ createdAt: "desc" }],
      select: {
        id: true,
        createdAt: true,
        result: true
      }
    });

    if (recentReminder) {
      return {
        deduped: true,
        previousRunId: recentReminder.id,
        sentAt: recentReminder.createdAt.toISOString(),
        previousResult: recentReminder.result
      };
    }

    const recipient = await this.resolveInvoiceRecipient(run.orgId, invoice.companyId);
    if (!recipient) {
      throw new BadRequestException("No recipient email found for invoice reminder");
    }

    const simulated = !process.env.RESEND_API_KEY || mode.dryRun;
    if (mode.dryRun) {
      return {
        dryRun: true,
        simulated: true,
        recipient,
        invoiceId: invoice.id,
        amount: Number(invoice.amount),
        status: invoice.status
      };
    }
    await this.activityLogService.log({
      orgId: run.orgId,
      actorUserId,
      entityType: ActivityEntityType.INVOICE,
      entityId: invoice.id,
      action: "INVOICE_REMINDER_SENT",
      after: {
        invoiceId: invoice.id,
        recipient,
        simulated
      }
    });

    return {
      simulated,
      recipient,
      invoiceId: invoice.id,
      amount: Number(invoice.amount),
      status: invoice.status
    };
  }

  private async executeReassignWork(
    run: FixActionRun & { template: TemplateLike },
    actorUserId: string,
    mode: ExecutionMode
  ): Promise<RunResult> {
    const input = this.asObject(run.input);
    const assigneeUserId = this.getStringInput(input, "assigneeUserId");
    if (!assigneeUserId) {
      throw new BadRequestException("assigneeUserId is required");
    }

    const reason = this.getStringInput(input, "reason") ?? "Fix action reassignment";

    const workItem = await this.prisma.workItem.findFirst({
      where: {
        id: run.entityId,
        orgId: run.orgId
      }
    });
    if (!workItem) {
      throw new NotFoundException("Work item not found");
    }

    const assignee = await this.prisma.user.findFirst({
      where: {
        id: assigneeUserId,
        orgId: run.orgId,
        isActive: true
      },
      select: { id: true, name: true, email: true }
    });

    if (!assignee) {
      throw new NotFoundException("Assignee user not found");
    }

    if (workItem.assignedToUserId === assignee.id) {
      return {
        unchanged: true,
        assigneeUserId: assignee.id
      };
    }

    if (mode.dryRun) {
      return {
        dryRun: true,
        workItemId: workItem.id,
        previousAssigneeUserId: workItem.assignedToUserId,
        assigneeUserId: assignee.id,
        reason
      };
    }

    const updated = await this.prisma.workItem.update({
      where: { id: workItem.id },
      data: {
        assignedToUserId: assignee.id
      }
    });

    await this.activityLogService.log({
      orgId: run.orgId,
      actorUserId,
      entityType: ActivityEntityType.WORK_ITEM,
      entityId: updated.id,
      action: "WORK_REASSIGNED",
      before: {
        assignedToUserId: workItem.assignedToUserId
      },
      after: {
        assignedToUserId: updated.assignedToUserId,
        reason
      }
    });

    return {
      workItemId: updated.id,
      previousAssigneeUserId: workItem.assignedToUserId,
      assigneeUserId: updated.assignedToUserId,
      reason
    };
  }

  private async executeSetDueDate(
    run: FixActionRun & { template: TemplateLike },
    authUser: AuthUserContext,
    mode: ExecutionMode
  ): Promise<RunResult> {
    const input = this.asObject(run.input);
    const dueAtValue = this.getStringInput(input, "dueAt");
    if (!dueAtValue) {
      throw new BadRequestException("dueAt is required");
    }

    const dueAt = new Date(dueAtValue);
    if (Number.isNaN(dueAt.getTime())) {
      throw new BadRequestException("dueAt must be a valid ISO date");
    }

    const reason = this.getStringInput(input, "reason") ?? "Fix action due date update";
    const today = new Date();
    if (dueAt.getTime() < today.getTime() && authUser.role !== Role.CEO && authUser.role !== Role.ADMIN) {
      throw new BadRequestException("dueAt cannot be in the past");
    }

    const config = this.asObject(run.template.config);
    const maxExtensionDays = this.getNumberInput(config, "maxDueExtensionDays");
    if (
      typeof maxExtensionDays === "number" &&
      authUser.role !== Role.CEO &&
      authUser.role !== Role.ADMIN
    ) {
      const maxAllowed = new Date();
      maxAllowed.setUTCDate(maxAllowed.getUTCDate() + maxExtensionDays);
      if (dueAt.getTime() > maxAllowed.getTime()) {
        throw new BadRequestException(`dueAt exceeds allowed extension window of ${maxExtensionDays} days`);
      }
    }

    if (run.entityType === "WORK_ITEM") {
      const workItem = await this.prisma.workItem.findFirst({
        where: { id: run.entityId, orgId: run.orgId }
      });
      if (!workItem) {
        throw new NotFoundException("Work item not found");
      }

      if (mode.dryRun) {
        return {
          dryRun: true,
          entityType: "WORK_ITEM",
          entityId: workItem.id,
          previousDueAt: workItem.dueDate?.toISOString() ?? null,
          dueAt: dueAt.toISOString(),
          reason
        };
      }

      const updated = await this.prisma.workItem.update({
        where: { id: workItem.id },
        data: { dueDate: dueAt }
      });

      await this.activityLogService.log({
        orgId: run.orgId,
        actorUserId: authUser.userId,
        entityType: ActivityEntityType.WORK_ITEM,
        entityId: updated.id,
        action: "DUE_DATE_CHANGED",
        before: { dueDate: workItem.dueDate },
        after: { dueDate: updated.dueDate, reason }
      });

      return {
        entityType: "WORK_ITEM",
        entityId: updated.id,
        previousDueAt: workItem.dueDate?.toISOString() ?? null,
        dueAt: updated.dueDate?.toISOString() ?? null,
        reason
      };
    }

    if (run.entityType === "INVOICE") {
      const invoice = await this.prisma.invoice.findFirst({
        where: { id: run.entityId, orgId: run.orgId }
      });
      if (!invoice) {
        throw new NotFoundException("Invoice not found");
      }

      if (mode.dryRun) {
        return {
          dryRun: true,
          entityType: "INVOICE",
          entityId: invoice.id,
          previousDueAt: invoice.dueDate?.toISOString() ?? null,
          dueAt: dueAt.toISOString(),
          reason
        };
      }

      const updated = await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: { dueDate: dueAt }
      });

      await this.activityLogService.log({
        orgId: run.orgId,
        actorUserId: authUser.userId,
        entityType: ActivityEntityType.INVOICE,
        entityId: updated.id,
        action: "DUE_DATE_CHANGED",
        before: { dueDate: invoice.dueDate },
        after: { dueDate: updated.dueDate, reason }
      });

      return {
        entityType: "INVOICE",
        entityId: updated.id,
        previousDueAt: invoice.dueDate?.toISOString() ?? null,
        dueAt: updated.dueDate?.toISOString() ?? null,
        reason
      };
    }

    throw new BadRequestException(`SET_DUE_DATE not supported for entityType ${run.entityType}`);
  }

  private async executeEscalateIncident(
    run: FixActionRun & { template: TemplateLike },
    actorUserId: string,
    mode: ExecutionMode
  ): Promise<RunResult> {
    const incident = await this.prisma.incident.findFirst({
      where: {
        id: run.entityId,
        orgId: run.orgId
      }
    });

    if (!incident) {
      throw new NotFoundException("Incident not found");
    }

    if (incident.status === "RESOLVED" || incident.status === "POSTMORTEM") {
      throw new ConflictException("Incident is already resolved");
    }

    if (mode.dryRun) {
      return {
        dryRun: true,
        incidentId: incident.id,
        status: incident.status,
        timelineCreated: false,
        nudgeCreated: false
      };
    }

    await this.prisma.incidentTimeline.create({
      data: {
        incidentId: incident.id,
        type: "ESCALATED",
        message: "Escalated by Fix Action",
        actorUserId,
        metadata: {
          source: "fix_action",
          runId: run.id
        } as Prisma.InputJsonValue
      }
    });

    const opsAssignee = await this.prisma.user.findFirst({
      where: {
        orgId: run.orgId,
        role: {
          in: [Role.OPS, Role.ADMIN, Role.CEO]
        },
        isActive: true
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true }
    });

    if (opsAssignee) {
      await this.prisma.nudge.create({
        data: {
          orgId: run.orgId,
          createdByUserId: actorUserId,
          targetUserId: opsAssignee.id,
          type: "MANUAL",
          entityType: ActivityEntityType.ALERT,
          entityId: incident.id,
          message: `Incident escalation required: ${incident.title}`,
          severity: "HIGH",
          priorityScore: 80,
          status: NudgeStatus.OPEN,
          meta: {
            source: "fix_action",
            runId: run.id,
            incidentId: incident.id
          } as Prisma.InputJsonValue
        }
      });
    }

    await this.activityLogService.log({
      orgId: run.orgId,
      actorUserId,
      entityType: ActivityEntityType.ALERT,
      entityId: incident.id,
      action: "INCIDENT_ESCALATED",
      after: {
        incidentId: incident.id,
        runId: run.id
      }
    });

    return {
      incidentId: incident.id,
      status: incident.status,
      timelineCreated: true,
      nudgeCreated: Boolean(opsAssignee)
    };
  }

  private assertFeatureEnabled(): void {
    if (!isFeatureEnabled("FEATURE_FIX_ACTIONS")) {
      throw new ServiceUnavailableException("Fix actions are disabled.");
    }
  }

  private assertRoleAllowed(role: Role, template: TemplateLike): void {
    const allowedRoles = this.toRoleArray(template.allowedRoles);
    if (!allowedRoles.includes(role)) {
      throw new ForbiddenException("Role is not allowed to execute this fix action template");
    }
  }

  private toRoleArray(value: Prisma.JsonValue): Role[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const roleSet = new Set(Object.values(Role));
    return value.filter((item): item is Role => typeof item === "string" && roleSet.has(item as Role));
  }

  private async assertEntityInOrg(orgId: string, entityType: string, entityId: string): Promise<void> {
    if (entityType === "INVOICE") {
      const invoice = await this.prisma.invoice.findFirst({
        where: { id: entityId, orgId },
        select: { id: true }
      });
      if (!invoice) {
        throw new NotFoundException("Invoice not found");
      }
      return;
    }

    if (entityType === "WORK_ITEM") {
      const workItem = await this.prisma.workItem.findFirst({
        where: { id: entityId, orgId },
        select: { id: true }
      });
      if (!workItem) {
        throw new NotFoundException("Work item not found");
      }
      return;
    }

    if (entityType === "INCIDENT") {
      const incident = await this.prisma.incident.findFirst({
        where: { id: entityId, orgId },
        select: { id: true }
      });
      if (!incident) {
        throw new NotFoundException("Incident not found");
      }
      return;
    }

    throw new BadRequestException("Unsupported entityType");
  }

  private assertTemplateEntityMatch(templateKey: TemplateKey, entityType: string): void {
    if (templateKey === "SEND_INVOICE_REMINDER" && entityType !== "INVOICE") {
      throw new BadRequestException("SEND_INVOICE_REMINDER can only target INVOICE");
    }
    if (templateKey === "REASSIGN_WORK" && entityType !== "WORK_ITEM") {
      throw new BadRequestException("REASSIGN_WORK can only target WORK_ITEM");
    }
    if (templateKey === "ESCALATE_INCIDENT" && entityType !== "INCIDENT") {
      throw new BadRequestException("ESCALATE_INCIDENT can only target INCIDENT");
    }
    if (templateKey === "SET_DUE_DATE" && entityType !== "WORK_ITEM" && entityType !== "INVOICE") {
      throw new BadRequestException("SET_DUE_DATE can only target WORK_ITEM or INVOICE");
    }
  }

  private buildIdempotencyKey(
    orgId: string,
    templateKey: string,
    entityType: string,
    entityId: string,
    input?: Record<string, unknown>
  ): string {
    const hash = createHash("sha256")
      .update(this.stableStringify(input ?? {}))
      .digest("hex")
      .slice(0, 24);
    return `${orgId}:${templateKey}:${entityType}:${entityId}:${hash}`;
  }

  private stableStringify(value: unknown): string {
    if (value === null || value === undefined) {
      return "null";
    }
    if (typeof value !== "object") {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(",")}]`;
    }

    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries
      .map(([key, nested]) => `${JSON.stringify(key)}:${this.stableStringify(nested)}`)
      .join(",")}}`;
  }

  private toActivityEntityType(entityType: string): ActivityEntityType {
    if (entityType === "INVOICE") {
      return ActivityEntityType.INVOICE;
    }
    if (entityType === "WORK_ITEM") {
      return ActivityEntityType.WORK_ITEM;
    }
    return ActivityEntityType.ALERT;
  }

  private asObject(value: Prisma.JsonValue | null): Record<string, unknown> {
    if (!value || Array.isArray(value) || typeof value !== "object") {
      return {};
    }
    return value as Record<string, unknown>;
  }

  private getStringInput(input: Record<string, unknown>, key: string): string | undefined {
    const value = input[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private getNumberInput(input: Record<string, unknown>, key: string): number | undefined {
    const value = input[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }

  private async assertRateLimit(orgId: string): Promise<void> {
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const count = await this.prisma.fixActionRun.count({
      where: {
        orgId,
        createdAt: { gte: since }
      }
    });

    if (count >= 30) {
      throw new ConflictException("Fix action rate limit exceeded for this org (30/hour)");
    }
  }

  private async resolveInvoiceRecipient(orgId: string, companyId: string): Promise<string | null> {
    const contact = await this.prisma.contact.findFirst({
      where: {
        orgId,
        companyId,
        email: {
          not: null
        }
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { email: true }
    });

    if (contact?.email) {
      return contact.email;
    }

    const finance = await this.prisma.user.findFirst({
      where: {
        orgId,
        role: Role.FINANCE,
        isActive: true
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { email: true }
    });

    return finance?.email ?? null;
  }
}
