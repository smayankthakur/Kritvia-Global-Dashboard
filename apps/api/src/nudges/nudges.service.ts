import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException
} from "@nestjs/common";
import { ActivityEntityType, NudgeStatus, Role } from "@prisma/client";
import { ActivityLogService } from "../activity-log/activity-log.service";
import { AuthUserContext } from "../auth/auth.types";
import { toPaginatedResponse } from "../common/dto/paginated-response.dto";
import { PrismaService } from "../prisma/prisma.service";
import { CreateNudgeDto } from "./dto/create-nudge.dto";
import { ListNudgesDto } from "./dto/list-nudges.dto";

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

    const created = await this.prisma.nudge.create({
      data: {
        orgId: authUser.orgId,
        createdByUserId: authUser.userId,
        targetUserId: dto.targetUserId,
        entityType: dto.entityType,
        entityId: dto.entityId,
        message: dto.message
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
        orderBy: [{ [sortBy]: query.sortDir }, { id: "asc" }],
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

  async listUsers(authUser: AuthUserContext) {
    return this.prisma.user.findMany({
      where: { orgId: authUser.orgId, isActive: true },
      select: { id: true, name: true, email: true, role: true },
      orderBy: { name: "asc" }
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

  private resolveSortField(sortBy?: string): "createdAt" | "status" | "entityType" {
    if (!sortBy) {
      return "createdAt";
    }
    if (sortBy === "createdAt" || sortBy === "status" || sortBy === "entityType") {
      return sortBy;
    }
    throw new BadRequestException("Invalid sortBy for nudges");
  }
}
