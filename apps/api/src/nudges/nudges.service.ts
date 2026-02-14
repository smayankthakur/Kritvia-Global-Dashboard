import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException
} from "@nestjs/common";
import {
  ActivityEntityType,
  DealStage,
  NudgeStatus,
  NudgeType,
  Prisma,
  Role
} from "@prisma/client";
import { ActivityLogService } from "../activity-log/activity-log.service";
import { AuthUserContext } from "../auth/auth.types";
import { toPaginatedResponse } from "../common/dto/paginated-response.dto";
import { PrismaService } from "../prisma/prisma.service";
import { CreateNudgeDto } from "./dto/create-nudge.dto";
import { ListNudgesDto } from "./dto/list-nudges.dto";
import { computeNudgeScore } from "./nudge-scoring.util";

@Injectable()
export class NudgesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLogService: ActivityLogService
  ) {}

  async create(dto: CreateNudgeDto, authUser: AuthUserContext) {
    this.assertCreatePermission(authUser, dto.entityType);
    await this.ensureTargetInOrg(dto.targetUserId, authUser.orgId);
    await this.ensureEntityInOrg(dto.entityType, dto.entityId, authUser.orgId);
    const nudgeType = this.resolveNudgeType(dto.entityType);
    const scoring = await this.buildNudgeScoreInput(authUser.orgId, nudgeType, dto.entityId);
    const scoreResult = computeNudgeScore(scoring);

    const created = await this.prisma.nudge.create({
      data: {
        orgId: authUser.orgId,
        createdByUserId: authUser.userId,
        targetUserId: dto.targetUserId,
        type: nudgeType,
        entityType: dto.entityType,
        entityId: dto.entityId,
        message: dto.message,
        severity: scoreResult.severity,
        priorityScore: scoreResult.priorityScore,
        meta: scoreResult.meta as Prisma.InputJsonValue
      },
      include: {
        createdByUser: { select: { id: true, name: true, email: true } },
        targetUser: { select: { id: true, name: true, email: true } }
      }
    });

    await this.activityLogService.log({
      orgId: authUser.orgId,
      actorUserId: authUser.userId,
      entityType: dto.entityType,
      entityId: dto.entityId,
      action: "NUDGE_CREATE",
      after: created
    });

    return created;
  }

  async list(query: ListNudgesDto, authUser: AuthUserContext) {
    const mine = query.mine !== "false";
    const sortBy = this.resolveSortField(query.sortBy);
    const skip = (query.page - 1) * query.pageSize;
    if (!mine && authUser.role !== Role.ADMIN) {
      throw new ForbiddenException("Only admin can view all nudges");
    }

    const where = {
      orgId: authUser.orgId,
      status: query.status,
      ...(mine
        ? {
            OR: [{ targetUserId: authUser.userId }, { createdByUserId: authUser.userId }]
          }
        : {})
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.nudge.findMany({
        where,
        orderBy:
          sortBy === "priorityScore"
            ? [{ priorityScore: query.sortDir }, { createdAt: "desc" }, { id: "asc" }]
            : [{ [sortBy]: query.sortDir }, { priorityScore: "desc" }, { id: "asc" }],
        skip,
        take: query.pageSize,
        include: {
          createdByUser: { select: { id: true, name: true, email: true } },
          targetUser: { select: { id: true, name: true, email: true } }
        }
      }),
      this.prisma.nudge.count({ where })
    ]);

    return toPaginatedResponse(items, query.page, query.pageSize, total);
  }

  async recomputeOpenScores(authUser: AuthUserContext): Promise<{ updated: number }> {
    if (authUser.role !== Role.ADMIN) {
      throw new ForbiddenException("Only admin can recompute nudge scores");
    }

    const openNudges = await this.prisma.nudge.findMany({
      where: {
        orgId: authUser.orgId,
        status: NudgeStatus.OPEN
      },
      select: {
        id: true,
        type: true,
        entityId: true
      }
    });

    let updated = 0;
    for (const nudge of openNudges) {
      const scoring = await this.buildNudgeScoreInput(authUser.orgId, nudge.type, nudge.entityId);
      const scoreResult = computeNudgeScore(scoring);
      await this.prisma.nudge.update({
        where: { id: nudge.id },
        data: {
          severity: scoreResult.severity,
          priorityScore: scoreResult.priorityScore,
          meta: scoreResult.meta as Prisma.InputJsonValue
        }
      });
      updated += 1;
    }

    return { updated };
  }

  async execute(id: string, authUser: AuthUserContext): Promise<{ success: true; undoExpiresAt: Date }> {
    const now = new Date();
    const nudge = await this.prisma.nudge.findFirst({
      where: { id, orgId: authUser.orgId }
    });
    if (!nudge) {
      throw new NotFoundException("Nudge not found");
    }
    if (nudge.executedAt) {
      throw new ConflictException("Nudge is already executed");
    }

    const execution = await this.executeByType(nudge, authUser, now);
    const undoExpiresAt = new Date(now.getTime() + 60_000);

    await this.prisma.nudge.update({
      where: { id: nudge.id },
      data: {
        actionType: execution.actionType,
        actionPayload: execution.actionPayload as Prisma.InputJsonValue,
        undoData: execution.undoData as Prisma.InputJsonValue,
        executedAt: now,
        undoExpiresAt
      }
    });

    await this.activityLogService.log({
      orgId: authUser.orgId,
      actorUserId: authUser.userId,
      entityType: nudge.entityType,
      entityId: nudge.entityId,
      action: "NUDGE_EXECUTED",
      after: { nudgeId: nudge.id, actionType: execution.actionType, undoExpiresAt }
    });

    return { success: true, undoExpiresAt };
  }

  async undo(id: string, authUser: AuthUserContext): Promise<{ success: true }> {
    const now = new Date();
    const nudge = await this.prisma.nudge.findFirst({
      where: { id, orgId: authUser.orgId }
    });
    if (!nudge) {
      throw new NotFoundException("Nudge not found");
    }
    if (!nudge.executedAt || !nudge.undoExpiresAt) {
      throw new ConflictException("Nudge has not been executed");
    }
    if (now.getTime() >= nudge.undoExpiresAt.getTime()) {
      throw new ConflictException("Undo window has expired");
    }
    if (!nudge.undoData || !nudge.actionType) {
      throw new ConflictException("Nudge cannot be undone");
    }

    await this.undoByActionType(nudge, authUser);

    await this.prisma.nudge.update({
      where: { id: nudge.id },
      data: {
        executedAt: null,
        undoExpiresAt: null,
        undoData: Prisma.JsonNull,
        actionType: null
      }
    });

    await this.activityLogService.log({
      orgId: authUser.orgId,
      actorUserId: authUser.userId,
      entityType: nudge.entityType,
      entityId: nudge.entityId,
      action: "NUDGE_UNDO",
      after: { nudgeId: nudge.id }
    });

    return { success: true };
  }

  async resolve(id: string, authUser: AuthUserContext) {
    const existing = await this.prisma.nudge.findFirst({
      where: { id, orgId: authUser.orgId }
    });
    if (!existing) {
      throw new NotFoundException("Nudge not found");
    }

    if (authUser.role !== Role.ADMIN && existing.targetUserId !== authUser.userId) {
      throw new UnauthorizedException("Only target user or admin can resolve");
    }

    if (existing.status === NudgeStatus.RESOLVED) {
      return existing;
    }

    const updated = await this.prisma.nudge.update({
      where: { id: existing.id },
      data: {
        status: NudgeStatus.RESOLVED,
        resolvedAt: new Date()
      },
      include: {
        createdByUser: { select: { id: true, name: true, email: true } },
        targetUser: { select: { id: true, name: true, email: true } }
      }
    });

    await this.activityLogService.log({
      orgId: authUser.orgId,
      actorUserId: authUser.userId,
      entityType: existing.entityType,
      entityId: existing.entityId,
      action: "NUDGE_RESOLVE",
      before: existing,
      after: updated
    });

    return updated;
  }

  async feed(authUser: AuthUserContext) {
    return this.prisma.nudge.findMany({
      where: {
        orgId: authUser.orgId,
        status: NudgeStatus.OPEN,
        OR: [{ targetUserId: authUser.userId }, { createdByUserId: authUser.userId }]
      },
      orderBy: { createdAt: "desc" },
      take: 30,
      include: {
        createdByUser: { select: { id: true, name: true, email: true } },
        targetUser: { select: { id: true, name: true, email: true } }
      }
    });
  }

  private assertCreatePermission(authUser: AuthUserContext, entityType: ActivityEntityType): void {
    if (
      authUser.role === Role.CEO ||
      authUser.role === Role.OPS ||
      authUser.role === Role.ADMIN
    ) {
      return;
    }
    if (authUser.role === Role.FINANCE && entityType === ActivityEntityType.INVOICE) {
      return;
    }
    throw new ForbiddenException("Insufficient role permissions to create nudge");
  }

  private async ensureTargetInOrg(targetUserId: string, orgId: string): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { id: targetUserId, orgId, isActive: true },
      select: { id: true }
    });
    if (!user) {
      throw new NotFoundException("Target user not found");
    }
  }

  private async ensureEntityInOrg(
    entityType: ActivityEntityType,
    entityId: string,
    orgId: string
  ): Promise<void> {
    let exists = false;

    switch (entityType) {
      case ActivityEntityType.COMPANY:
        exists = !!(await this.prisma.company.findFirst({
          where: { id: entityId, orgId },
          select: { id: true }
        }));
        break;
      case ActivityEntityType.CONTACT:
        exists = !!(await this.prisma.contact.findFirst({
          where: { id: entityId, orgId },
          select: { id: true }
        }));
        break;
      case ActivityEntityType.LEAD:
        exists = !!(await this.prisma.lead.findFirst({
          where: { id: entityId, orgId },
          select: { id: true }
        }));
        break;
      case ActivityEntityType.DEAL:
        exists = !!(await this.prisma.deal.findFirst({
          where: { id: entityId, orgId },
          select: { id: true }
        }));
        break;
      case ActivityEntityType.WORK_ITEM:
        exists = !!(await this.prisma.workItem.findFirst({
          where: { id: entityId, orgId },
          select: { id: true }
        }));
        break;
      case ActivityEntityType.INVOICE:
        exists = !!(await this.prisma.invoice.findFirst({
          where: { id: entityId, orgId },
          select: { id: true }
        }));
        break;
      default:
        throw new ForbiddenException("Unsupported entity type for nudge");
    }

    if (!exists) {
      throw new NotFoundException("Entity not found");
    }
  }

  private resolveSortField(
    sortBy?: string
  ): "createdAt" | "status" | "entityType" | "priorityScore" {
    if (!sortBy) {
      return "priorityScore";
    }
    if (
      sortBy === "createdAt" ||
      sortBy === "status" ||
      sortBy === "entityType" ||
      sortBy === "priorityScore"
    ) {
      return sortBy;
    }
    throw new BadRequestException("Invalid sortBy for nudges");
  }

  private async executeByType(
    nudge: {
      id: string;
      orgId: string;
      entityType: ActivityEntityType;
      entityId: string;
      type: NudgeType;
      targetUserId: string;
      actionPayload: Prisma.JsonValue | null;
    },
    authUser: AuthUserContext,
    now: Date
  ): Promise<{
    actionType: string;
    actionPayload: Record<string, unknown>;
    undoData: Record<string, unknown>;
  }> {
    const payload = (nudge.actionPayload ?? {}) as Record<string, unknown>;

    if (nudge.type === NudgeType.OVERDUE_WORK) {
      const workItem = await this.prisma.workItem.findFirst({
        where: { id: nudge.entityId, orgId: nudge.orgId },
        include: {
          deal: { select: { ownerUserId: true } }
        }
      });
      if (!workItem) {
        throw new NotFoundException("Work item not found");
      }

      this.assertExecutePermissions(authUser, nudge, {
        workOwnerUserId: workItem.assignedToUserId,
        workCreatedByUserId: workItem.createdByUserId,
        dealOwnerUserId: workItem.deal?.ownerUserId ?? null
      });

      const nextAssignedToUserId =
        typeof payload.assignedToUserId === "string" && payload.assignedToUserId.length > 0
          ? payload.assignedToUserId
          : workItem.assignedToUserId ?? nudge.targetUserId;
      const nextDueDate =
        typeof payload.dueDate === "string" && payload.dueDate.length > 0
          ? new Date(payload.dueDate)
          : new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);

      const updated = await this.prisma.workItem.update({
        where: { id: workItem.id },
        data: {
          assignedToUserId: nextAssignedToUserId,
          dueDate: nextDueDate
        }
      });

      return {
        actionType: "WORK_ITEM_UPDATE",
        actionPayload: {
          assignedToUserId: nextAssignedToUserId,
          dueDate: nextDueDate.toISOString()
        },
        undoData: {
          workItemId: updated.id,
          previousAssignedToUserId: workItem.assignedToUserId,
          previousDueDate: workItem.dueDate ? workItem.dueDate.toISOString() : null
        }
      };
    }

    if (nudge.type === NudgeType.OVERDUE_INVOICE) {
      const invoice = await this.prisma.invoice.findFirst({
        where: { id: nudge.entityId, orgId: nudge.orgId }
      });
      if (!invoice) {
        throw new NotFoundException("Invoice not found");
      }

      this.assertExecutePermissions(authUser, nudge, {
        invoiceCreatedByUserId: invoice.createdByUserId
      });

      if (!invoice.lockedAt) {
        await this.prisma.invoice.update({
          where: { id: invoice.id },
          data: {
            lockedAt: now,
            lockedByUserId: authUser.userId
          }
        });
      }

      return {
        actionType: "INVOICE_LOCK",
        actionPayload: { lockedAt: now.toISOString(), lockedByUserId: authUser.userId },
        undoData: {
          invoiceId: invoice.id,
          previousLockedAt: invoice.lockedAt ? invoice.lockedAt.toISOString() : null,
          previousLockedByUserId: invoice.lockedByUserId
        }
      };
    }

    if (nudge.type === NudgeType.STALE_DEAL) {
      const deal = await this.prisma.deal.findFirst({
        where: { id: nudge.entityId, orgId: nudge.orgId }
      });
      if (!deal) {
        throw new NotFoundException("Deal not found");
      }

      this.assertExecutePermissions(authUser, nudge, {
        dealOwnerUserId: deal.ownerUserId
      });

      const nextOwnerUserId =
        typeof payload.ownerUserId === "string" && payload.ownerUserId.length > 0
          ? payload.ownerUserId
          : deal.ownerUserId ?? nudge.targetUserId;
      const nextStage =
        payload.stage === DealStage.OPEN || payload.stage === DealStage.WON || payload.stage === DealStage.LOST
          ? payload.stage
          : deal.stage;

      const updated = await this.prisma.deal.update({
        where: { id: deal.id },
        data: {
          ownerUserId: nextOwnerUserId,
          stage: nextStage
        }
      });

      return {
        actionType: "DEAL_UPDATE",
        actionPayload: {
          ownerUserId: nextOwnerUserId,
          stage: nextStage
        },
        undoData: {
          dealId: updated.id,
          previousOwnerUserId: deal.ownerUserId,
          previousStage: deal.stage
        }
      };
    }

    throw new BadRequestException("Unsupported nudge type for execute");
  }

  private async undoByActionType(
    nudge: {
      id: string;
      orgId: string;
      entityId: string;
      type: NudgeType;
      actionType: string | null;
      undoData: Prisma.JsonValue | null;
    },
    authUser: AuthUserContext
  ): Promise<void> {
    const undoData = (nudge.undoData ?? {}) as Record<string, unknown>;
    this.assertExecutePermissions(authUser, nudge, {});

    if (nudge.actionType === "WORK_ITEM_UPDATE") {
      await this.prisma.workItem.update({
        where: { id: String(undoData.workItemId ?? nudge.entityId) },
        data: {
          assignedToUserId:
            undoData.previousAssignedToUserId === null
              ? null
              : (undoData.previousAssignedToUserId as string | null | undefined),
          dueDate:
            typeof undoData.previousDueDate === "string"
              ? new Date(undoData.previousDueDate)
              : null
        }
      });
      return;
    }

    if (nudge.actionType === "INVOICE_LOCK") {
      await this.prisma.invoice.update({
        where: { id: String(undoData.invoiceId ?? nudge.entityId) },
        data: {
          lockedAt:
            typeof undoData.previousLockedAt === "string"
              ? new Date(undoData.previousLockedAt)
              : null,
          lockedByUserId:
            undoData.previousLockedByUserId === null
              ? null
              : (undoData.previousLockedByUserId as string | null | undefined)
        }
      });
      return;
    }

    if (nudge.actionType === "DEAL_UPDATE") {
      await this.prisma.deal.update({
        where: { id: String(undoData.dealId ?? nudge.entityId) },
        data: {
          ownerUserId:
            undoData.previousOwnerUserId === null
              ? null
              : (undoData.previousOwnerUserId as string | null | undefined),
          stage: (undoData.previousStage as DealStage | undefined) ?? DealStage.OPEN
        }
      });
      return;
    }

    throw new ConflictException("Nudge action cannot be undone");
  }

  private assertExecutePermissions(
    authUser: AuthUserContext,
    nudge: { type: NudgeType },
    ownership: {
      dealOwnerUserId?: string | null;
      workOwnerUserId?: string | null;
      workCreatedByUserId?: string | null;
      invoiceCreatedByUserId?: string | null;
    }
  ): void {
    if (authUser.role === Role.ADMIN || authUser.role === Role.CEO) {
      return;
    }

    if (authUser.role === Role.OPS) {
      if (nudge.type === NudgeType.OVERDUE_INVOICE) {
        throw new ForbiddenException("OPS cannot execute invoice lock nudges");
      }
      return;
    }

    if (authUser.role === Role.SALES) {
      if (nudge.type === NudgeType.OVERDUE_INVOICE) {
        throw new ForbiddenException("SALES cannot execute invoice nudges");
      }
      const owned =
        ownership.dealOwnerUserId === authUser.userId ||
        ownership.workOwnerUserId === authUser.userId ||
        ownership.workCreatedByUserId === authUser.userId ||
        ownership.invoiceCreatedByUserId === authUser.userId;
      if (!owned) {
        throw new ForbiddenException("SALES can execute only their own entities");
      }
      return;
    }

    throw new ForbiddenException("Insufficient role permissions");
  }

  resolveNudgeType(entityType: ActivityEntityType): NudgeType {
    if (entityType === ActivityEntityType.INVOICE) {
      return NudgeType.OVERDUE_INVOICE;
    }
    if (entityType === ActivityEntityType.WORK_ITEM) {
      return NudgeType.OVERDUE_WORK;
    }
    if (entityType === ActivityEntityType.DEAL) {
      return NudgeType.STALE_DEAL;
    }
    return NudgeType.MANUAL;
  }

  async buildNudgeScoreInput(
    orgId: string,
    type: NudgeType,
    entityId: string
  ): Promise<{
    type: NudgeType;
    now: Date;
    dueDate?: Date | null;
    amount?: number | null;
    dealValue?: number | null;
    updatedAt?: Date | null;
  }> {
    const now = new Date();
    if (type === NudgeType.OVERDUE_INVOICE) {
      const invoice = await this.prisma.invoice.findFirst({
        where: { id: entityId, orgId },
        select: { dueDate: true, amount: true }
      });
      return {
        type,
        now,
        dueDate: invoice?.dueDate,
        amount: invoice ? Number(invoice.amount) : 0
      };
    }

    if (type === NudgeType.OVERDUE_WORK) {
      const workItem = await this.prisma.workItem.findFirst({
        where: { id: entityId, orgId },
        select: {
          dueDate: true,
          deal: { select: { valueAmount: true } }
        }
      });
      return {
        type,
        now,
        dueDate: workItem?.dueDate,
        dealValue: workItem?.deal?.valueAmount ?? 0
      };
    }

    if (type === NudgeType.STALE_DEAL) {
      const deal = await this.prisma.deal.findFirst({
        where: { id: entityId, orgId },
        select: { updatedAt: true }
      });
      return {
        type,
        now,
        updatedAt: deal?.updatedAt
      };
    }

    return { type, now };
  }
}
