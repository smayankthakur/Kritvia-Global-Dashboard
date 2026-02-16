import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import {
  ActivityEntityType,
  NudgeStatus,
  NudgeType,
  Prisma,
  Role
} from "@prisma/client";
import { ActivityLogService } from "../activity-log/activity-log.service";
import { AuthUserContext } from "../auth/auth.types";
import { BillingService } from "../billing/billing.service";
import { toPaginatedResponse } from "../common/dto/paginated-response.dto";
import { WEBHOOK_EVENTS } from "../org-webhooks/webhook-events";
import { WebhookService } from "../org-webhooks/webhook.service";
import { PrismaService } from "../prisma/prisma.service";
import { ListAiActionsDto } from "./dto/list-ai-actions.dto";
import { AIActionType, ComputeActionsResponse } from "./ai-actions.types";

const EXECUTE_UNDO_MS = 60_000;

@Injectable()
export class AiActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billingService: BillingService,
    private readonly activityLogService: ActivityLogService,
    private readonly webhookService: WebhookService
  ) {}

  async computeActions(orgId: string): Promise<ComputeActionsResponse> {
    await this.billingService.assertFeature(orgId, "autopilotEnabled");

    const policy = await this.prisma.policy.findUnique({
      where: { orgId },
      select: { lockInvoiceOnSent: true }
    });
    const insights = await this.prisma.aIInsight.findMany({
      where: { orgId, isResolved: false },
      orderBy: [{ createdAt: "desc" }],
      take: 20
    });

    let created = 0;
    let skipped = 0;

    for (const insight of insights) {
      const proposals = await this.buildProposals(orgId, insight, !!policy?.lockInvoiceOnSent);
      for (const proposal of proposals) {
        const exists = await this.prisma.aIAction.findFirst({
          where: {
            orgId,
            insightId: insight.id,
            type: proposal.type,
            status: { in: ["PROPOSED", "APPROVED"] }
          },
          select: { id: true }
        });
        if (exists) {
          skipped += 1;
          continue;
        }

        await this.prisma.aIAction.create({
          data: {
            orgId,
            insightId: insight.id,
            type: proposal.type,
            status: "PROPOSED",
            title: proposal.title,
            rationale: proposal.rationale,
            payload: proposal.payload
          }
        });
        created += 1;
      }
    }

    const totalProposed = await this.prisma.aIAction.count({
      where: { orgId, status: "PROPOSED" }
    });
    return {
      created,
      skipped,
      totalProposed
    };
  }

  async listActions(orgId: string, query: ListAiActionsDto) {
    const skip = (query.page - 1) * query.pageSize;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.aIAction.findMany({
        where: {
          orgId,
          status: query.status
        },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip,
        take: query.pageSize
      }),
      this.prisma.aIAction.count({
        where: {
          orgId,
          status: query.status
        }
      })
    ]);

    return toPaginatedResponse(items, query.page, query.pageSize, total);
  }

  async approveAction(orgId: string, id: string, actorUserId: string) {
    const action = await this.getActionOr404(orgId, id);
    if (action.status !== "PROPOSED") {
      throw new ConflictException("Only PROPOSED actions can be approved");
    }

    const updated = await this.prisma.aIAction.update({
      where: { id: action.id },
      data: {
        status: "APPROVED",
        approvedByUserId: actorUserId,
        approvedAt: new Date(),
        error: null
      }
    });

    await this.activityLogService.log({
      orgId,
      actorUserId,
      entityType: ActivityEntityType.AI_ACTION,
      entityId: action.id,
      action: "AI_ACTION_APPROVED",
      after: { status: updated.status, type: updated.type }
    });

    return updated;
  }

  async executeAction(orgId: string, id: string, authUser: AuthUserContext) {
    const action = await this.getActionOr404(orgId, id);
    if (action.status !== "APPROVED") {
      throw new ConflictException("Only APPROVED actions can be executed");
    }

    if (
      authUser.role === Role.OPS &&
      action.type !== "CREATE_NUDGE" &&
      action.type !== "CREATE_WORK_ITEM"
    ) {
      throw new ForbiddenException("OPS cannot execute this action type");
    }

    try {
      const now = new Date();
      const execution = await this.performExecution(orgId, action, authUser, now);
      const updated = await this.prisma.aIAction.update({
        where: { id: action.id },
        data: {
          status: "EXECUTED",
          executedByUserId: authUser.userId,
          executedAt: now,
          undoData: execution.undoData ?? Prisma.JsonNull,
          undoExpiresAt: execution.undoData ? new Date(now.getTime() + EXECUTE_UNDO_MS) : null,
          error: null
        }
      });

      await this.activityLogService.log({
        orgId,
        actorUserId: authUser.userId,
        entityType: ActivityEntityType.AI_ACTION,
        entityId: action.id,
        action: "AI_ACTION_EXECUTED",
        after: {
          type: action.type,
          status: updated.status
        }
      });
      void this.webhookService.dispatch(orgId, WEBHOOK_EVENTS.AI_ACTION_EXECUTED, {
        orgId,
        actionId: updated.id,
        insightId: updated.insightId,
        type: updated.type,
        status: updated.status,
        executedByUserId: authUser.userId,
        executedAt: updated.executedAt?.toISOString() ?? null
      });
      return updated;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Execution failed";
      await this.prisma.aIAction.update({
        where: { id: action.id },
        data: {
          status: "FAILED",
          error: message
        }
      });
      await this.activityLogService.log({
        orgId,
        actorUserId: authUser.userId,
        entityType: ActivityEntityType.AI_ACTION,
        entityId: action.id,
        action: "AI_ACTION_FAILED",
        after: { type: action.type, error: message }
      });
      throw error;
    }
  }

  async undoAction(orgId: string, id: string, actorUserId: string) {
    const action = await this.getActionOr404(orgId, id);
    if (action.status !== "EXECUTED") {
      throw new ConflictException("Only EXECUTED actions can be undone");
    }
    if (!action.undoData || !action.undoExpiresAt) {
      throw new ConflictException("Action is not undoable");
    }
    if (new Date().getTime() >= action.undoExpiresAt.getTime()) {
      throw new ConflictException("Undo window expired");
    }

    await this.performUndo(orgId, action);

    const updated = await this.prisma.aIAction.update({
      where: { id: action.id },
      data: {
        status: "CANCELED",
        undoData: Prisma.JsonNull,
        undoExpiresAt: null,
        error: null
      }
    });

    await this.activityLogService.log({
      orgId,
      actorUserId,
      entityType: ActivityEntityType.AI_ACTION,
      entityId: action.id,
      action: "AI_ACTION_UNDO",
      after: { status: updated.status, type: action.type }
    });

    return updated;
  }

  private async buildProposals(
    orgId: string,
    insight: {
      id: string;
      type: string;
      title: string;
      explanation: string;
    },
    lockInvoiceOnSent: boolean
  ): Promise<
    Array<{
      type: AIActionType;
      title: string;
      rationale: string;
      payload: Prisma.InputJsonValue;
    }>
  > {
    const proposals: Array<{
      type: AIActionType;
      title: string;
      rationale: string;
      payload: Prisma.InputJsonValue;
    }> = [];

    if (insight.type === "DEAL_STALL") {
      proposals.push({
        type: "CREATE_NUDGE",
        title: "Nudge Sales on stalled deals",
        rationale: insight.explanation,
        payload: {
          targetRole: "SALES",
          message: "Follow up on stalled deals",
          link: "/sales/deals?filter=stale",
          entityType: ActivityEntityType.DEAL,
          entityId: insight.id
        } satisfies Prisma.InputJsonValue
      });
    } else if (insight.type === "CASHFLOW_ALERT") {
      proposals.push({
        type: "CREATE_NUDGE",
        title: "Nudge Finance on overdue invoices",
        rationale: insight.explanation,
        payload: {
          targetRole: "FINANCE",
          message: "Overdue invoices need follow-up",
          link: "/finance/invoices?filter=overdue",
          entityType: ActivityEntityType.INVOICE,
          entityId: insight.id
        } satisfies Prisma.InputJsonValue
      });

      if (lockInvoiceOnSent) {
        const topUnlocked = await this.prisma.invoice.findFirst({
          where: {
            orgId,
            status: "SENT",
            lockedAt: null
          },
          orderBy: { dueDate: "asc" },
          select: { id: true }
        });
        if (topUnlocked) {
          proposals.push({
            type: "LOCK_INVOICE",
            title: "Lock highest-risk overdue invoice",
            rationale: "Invoice is sent but still unlocked under cashflow risk.",
            payload: {
              invoiceId: topUnlocked.id
            } satisfies Prisma.InputJsonValue
          });
        }
      }
    } else if (insight.type === "OPS_RISK") {
      proposals.push({
        type: "CREATE_NUDGE",
        title: "Nudge Ops on overdue workload",
        rationale: insight.explanation,
        payload: {
          targetRole: "OPS",
          message: "Overdue work items-prioritize today",
          link: "/ops/work?filter=overdue",
          entityType: ActivityEntityType.WORK_ITEM,
          entityId: insight.id
        } satisfies Prisma.InputJsonValue
      });
    } else if (insight.type === "SHIELD_RISK") {
      proposals.push({
        type: "CREATE_NUDGE",
        title: "Escalate critical shield events",
        rationale: insight.explanation,
        payload: {
          targetRole: "CEO",
          message: "Critical security events require attention",
          link: "/shield",
          entityType: ActivityEntityType.AUTH,
          entityId: orgId
        } satisfies Prisma.InputJsonValue
      });
    } else if (insight.type === "HEALTH_DROP") {
      proposals.push({
        type: "CREATE_NUDGE",
        title: "Escalate execution score drop",
        rationale: insight.explanation,
        payload: {
          targetRole: "CEO",
          message: "Execution score dropped-review top blockers",
          link: "/ceo/action-mode",
          entityType: ActivityEntityType.POLICY,
          entityId: orgId
        } satisfies Prisma.InputJsonValue
      });
    }

    return proposals;
  }

  private async performExecution(
    orgId: string,
    action: {
      id: string;
      insightId: string | null;
      type: string;
      payload: Prisma.JsonValue;
    },
    authUser: AuthUserContext,
    now: Date
  ): Promise<{ undoData?: Prisma.InputJsonValue }> {
    const payload = this.payloadToRecord(action.payload);

    if (action.type === "CREATE_NUDGE") {
      const targetRole = this.parseRole(payload.targetRole, "FINANCE");
      const target = await this.resolveTargetUser(orgId, targetRole);
      const entityType = this.parseEntityType(payload.entityType, ActivityEntityType.AUTH);
      const entityId = typeof payload.entityId === "string" ? payload.entityId : orgId;
      const message =
        typeof payload.message === "string" ? payload.message : "AI action generated nudge";

      const created = await this.prisma.nudge.create({
        data: {
          orgId,
          createdByUserId: authUser.userId,
          targetUserId: target.id,
          type: NudgeType.MANUAL,
          entityType,
          entityId,
          message,
          status: NudgeStatus.OPEN
        },
        select: { id: true }
      });

      return {
        undoData: {
          createdNudgeId: created.id
        } satisfies Prisma.InputJsonValue
      };
    }

    if (action.type === "CREATE_WORK_ITEM") {
      const title =
        typeof payload.title === "string" && payload.title.trim().length > 0
          ? payload.title
          : "AI action work item";
      const created = await this.prisma.workItem.create({
        data: {
          orgId,
          title,
          description: typeof payload.description === "string" ? payload.description : null,
          status: "TODO",
          createdByUserId: authUser.userId,
          assignedToUserId:
            typeof payload.assigneeId === "string" ? payload.assigneeId : null,
          dueDate:
            typeof payload.dueDate === "string" ? new Date(payload.dueDate) : null,
          dealId: typeof payload.dealId === "string" ? payload.dealId : null,
          companyId: typeof payload.companyId === "string" ? payload.companyId : null
        },
        select: { id: true }
      });
      return {
        undoData: {
          createdWorkItemId: created.id
        } satisfies Prisma.InputJsonValue
      };
    }

    if (action.type === "LOCK_INVOICE") {
      const invoiceId = typeof payload.invoiceId === "string" ? payload.invoiceId : null;
      if (!invoiceId) {
        throw new BadRequestException("LOCK_INVOICE payload requires invoiceId");
      }
      const invoice = await this.prisma.invoice.findFirst({
        where: { id: invoiceId, orgId }
      });
      if (!invoice) {
        throw new NotFoundException("Invoice not found");
      }
      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          lockedAt: now,
          lockedByUserId: authUser.userId
        }
      });
      return {
        undoData: {
          invoiceId: invoice.id,
          previousLockedAt: invoice.lockedAt ? invoice.lockedAt.toISOString() : null,
          previousLockedByUserId: invoice.lockedByUserId
        } satisfies Prisma.InputJsonValue
      };
    }

    if (action.type === "REASSIGN_WORK") {
      const workItemId = typeof payload.workItemId === "string" ? payload.workItemId : null;
      const assigneeId = typeof payload.assigneeId === "string" ? payload.assigneeId : null;
      if (!workItemId || !assigneeId) {
        throw new BadRequestException("REASSIGN_WORK payload requires workItemId and assigneeId");
      }
      const workItem = await this.prisma.workItem.findFirst({
        where: { id: workItemId, orgId }
      });
      if (!workItem) {
        throw new NotFoundException("Work item not found");
      }
      await this.prisma.workItem.update({
        where: { id: workItem.id },
        data: { assignedToUserId: assigneeId }
      });
      return {
        undoData: {
          workItemId: workItem.id,
          previousAssigneeId: workItem.assignedToUserId
        } satisfies Prisma.InputJsonValue
      };
    }

    throw new BadRequestException("Unsupported AI action type");
  }

  private async performUndo(
    orgId: string,
    action: {
      id: string;
      type: string;
      undoData: Prisma.JsonValue | null;
    }
  ): Promise<void> {
    const undoData = this.payloadToRecord(action.undoData);
    if (action.type === "CREATE_NUDGE") {
      const nudgeId = typeof undoData.createdNudgeId === "string" ? undoData.createdNudgeId : null;
      if (!nudgeId) {
        throw new ConflictException("Undo data missing nudge id");
      }
      await this.prisma.nudge.deleteMany({
        where: { id: nudgeId, orgId }
      });
      return;
    }

    if (action.type === "CREATE_WORK_ITEM") {
      const workItemId =
        typeof undoData.createdWorkItemId === "string" ? undoData.createdWorkItemId : null;
      if (!workItemId) {
        throw new ConflictException("Undo data missing work item id");
      }
      await this.prisma.workItem.deleteMany({
        where: { id: workItemId, orgId }
      });
      return;
    }

    if (action.type === "LOCK_INVOICE") {
      const invoiceId = typeof undoData.invoiceId === "string" ? undoData.invoiceId : null;
      if (!invoiceId) {
        throw new ConflictException("Undo data missing invoice id");
      }
      await this.prisma.invoice.updateMany({
        where: { id: invoiceId, orgId },
        data: {
          lockedAt:
            typeof undoData.previousLockedAt === "string"
              ? new Date(undoData.previousLockedAt)
              : null,
          lockedByUserId:
            typeof undoData.previousLockedByUserId === "string"
              ? undoData.previousLockedByUserId
              : null
        }
      });
      return;
    }

    if (action.type === "REASSIGN_WORK") {
      const workItemId = typeof undoData.workItemId === "string" ? undoData.workItemId : null;
      if (!workItemId) {
        throw new ConflictException("Undo data missing work item id");
      }
      await this.prisma.workItem.updateMany({
        where: { id: workItemId, orgId },
        data: {
          assignedToUserId:
            typeof undoData.previousAssigneeId === "string" ? undoData.previousAssigneeId : null
        }
      });
      return;
    }

    throw new ConflictException("Unsupported action type for undo");
  }

  private payloadToRecord(value: Prisma.JsonValue | null): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    return value as Record<string, unknown>;
  }

  private async resolveTargetUser(orgId: string, role: Role): Promise<{ id: string }> {
    const target = await this.prisma.user.findFirst({
      where: {
        orgId,
        role,
        isActive: true
      },
      select: { id: true }
    });
    if (!target) {
      throw new NotFoundException(`No active ${role} user found for action execution`);
    }
    return target;
  }

  private parseRole(value: unknown, fallback: Role): Role {
    if (
      value === Role.ADMIN ||
      value === Role.CEO ||
      value === Role.OPS ||
      value === Role.SALES ||
      value === Role.FINANCE
    ) {
      return value;
    }
    return fallback;
  }

  private parseEntityType(value: unknown, fallback: ActivityEntityType): ActivityEntityType {
    if (
      value === ActivityEntityType.AUTH ||
      value === ActivityEntityType.USER ||
      value === ActivityEntityType.POLICY ||
      value === ActivityEntityType.PORTFOLIO ||
      value === ActivityEntityType.API_TOKEN ||
      value === ActivityEntityType.AI_INSIGHT ||
      value === ActivityEntityType.AI_ACTION ||
      value === ActivityEntityType.COMPANY ||
      value === ActivityEntityType.CONTACT ||
      value === ActivityEntityType.LEAD ||
      value === ActivityEntityType.DEAL ||
      value === ActivityEntityType.WORK_ITEM ||
      value === ActivityEntityType.INVOICE
    ) {
      return value;
    }
    return fallback;
  }

  private async getActionOr404(orgId: string, id: string) {
    const action = await this.prisma.aIAction.findFirst({
      where: { id, orgId }
    });
    if (!action) {
      throw new NotFoundException("AI action not found");
    }
    return action;
  }
}
