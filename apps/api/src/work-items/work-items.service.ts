import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { ActivityEntityType, Prisma, WorkItemStatus } from "@prisma/client";
import { ActivityLogService } from "../activity-log/activity-log.service";
import { AuthUserContext } from "../auth/auth.types";
import { PaginationQueryDto } from "../common/dto/pagination-query.dto";
import { toPaginatedResponse } from "../common/dto/paginated-response.dto";
import { PrismaService } from "../prisma/prisma.service";
import { PolicyResolverService } from "../policy/policy-resolver.service";
import { CreateWorkItemDto } from "./dto/create-work-item.dto";
import { ListWorkItemsDto } from "./dto/list-work-items.dto";
import { TransitionWorkItemDto } from "./dto/transition-work-item.dto";
import { UpdateWorkItemDto } from "./dto/update-work-item.dto";

function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function endOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
}

@Injectable()
export class WorkItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLogService: ActivityLogService,
    private readonly policyResolverService: PolicyResolverService
  ) {}

  async findAll(authUser: AuthUserContext, query: ListWorkItemsDto) {
    const sortBy = this.resolveSortField(query.sortBy);
    const skip = (query.page - 1) * query.pageSize;
    const where: Prisma.WorkItemWhereInput = {
      orgId: authUser.orgId,
      status: query.status,
      assignedToUserId: query.assignedTo
    };

    if (query.due && query.due !== "all") {
      const todayStart = startOfDay(new Date());
      const tomorrowStart = endOfDay(todayStart);
      const weekEnd = endOfDay(new Date(Date.UTC(
        todayStart.getUTCFullYear(),
        todayStart.getUTCMonth(),
        todayStart.getUTCDate() + 7
      )));

      if (query.due === "overdue") {
        where.dueDate = { lt: todayStart };
      } else if (query.due === "today") {
        where.dueDate = { gte: todayStart, lt: tomorrowStart };
      } else if (query.due === "week") {
        where.dueDate = { gte: todayStart, lt: weekEnd };
      }
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.workItem.findMany({
        where,
        orderBy: [{ [sortBy]: query.sortDir }, { id: "asc" }],
        skip,
        take: query.pageSize,
        include: {
          assignedToUser: {
            select: { id: true, name: true, email: true }
          },
          createdByUser: {
            select: { id: true, name: true, email: true }
          },
          company: {
            select: { id: true, name: true }
          },
          deal: {
            select: { id: true, title: true, stage: true }
          }
        }
      }),
      this.prisma.workItem.count({ where })
    ]);

    return toPaginatedResponse(items, query.page, query.pageSize, total);
  }

  async getById(id: string, authUser: AuthUserContext) {
    const workItem = await this.prisma.workItem.findFirst({
      where: { id, orgId: authUser.orgId },
      include: {
        assignedToUser: {
          select: { id: true, name: true, email: true }
        },
        createdByUser: {
          select: { id: true, name: true, email: true }
        },
        company: {
          select: { id: true, name: true }
        },
        deal: {
          select: { id: true, title: true, stage: true }
        }
      }
    });

    if (!workItem) {
      throw new NotFoundException("Work item not found");
    }

    return workItem;
  }

  async create(dto: CreateWorkItemDto, authUser: AuthUserContext) {
    const policy = await this.policyResolverService.getPolicyForOrg(authUser.orgId);
    if (policy.requireWorkOwner && !dto.assignedToUserId) {
      throw new ConflictException("Work item owner is required by org policy");
    }

    await this.ensureUserInOrg(dto.assignedToUserId, authUser.orgId);
    await this.ensureCompanyInOrg(dto.companyId, authUser.orgId);
    await this.ensureDealInOrg(dto.dealId, authUser.orgId);

    const status = dto.status ?? WorkItemStatus.TODO;
    const dueDate = this.resolveDueDateForCreate(dto.dueDate, policy.defaultWorkDueDays, policy.requireWorkDueDate);
    const created = await this.prisma.workItem.create({
      data: {
        orgId: authUser.orgId,
        title: dto.title,
        description: dto.description,
        status,
        priority: dto.priority ?? 2,
        dueDate,
        assignedToUserId: dto.assignedToUserId,
        createdByUserId: authUser.userId,
        companyId: dto.companyId,
        dealId: dto.dealId,
        completedAt: status === WorkItemStatus.DONE ? new Date() : null
      }
    });

    await this.activityLogService.log({
      orgId: authUser.orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.WORK_ITEM,
      entityId: created.id,
      action: "CREATE",
      after: created
    });

    if (!dto.dueDate && dueDate) {
      await this.activityLogService.log({
        orgId: authUser.orgId,
        actorUserId: authUser.userId,
        entityType: ActivityEntityType.WORK_ITEM,
        entityId: created.id,
        action: "AUTO_DUE_DATE_SET",
        after: { dueDate }
      });
    }

    return created;
  }

  async update(id: string, dto: UpdateWorkItemDto, authUser: AuthUserContext) {
    const policy = await this.policyResolverService.getPolicyForOrg(authUser.orgId);
    const existing = await this.prisma.workItem.findFirst({
      where: { id, orgId: authUser.orgId }
    });

    if (!existing) {
      throw new NotFoundException("Work item not found");
    }

    await this.ensureUserInOrg(dto.assignedToUserId, authUser.orgId);
    await this.ensureCompanyInOrg(dto.companyId, authUser.orgId);
    await this.ensureDealInOrg(dto.dealId, authUser.orgId);

    if (policy.requireWorkOwner) {
      if (dto.assignedToUserId === null) {
        throw new ConflictException("Work item owner cannot be unset while policy requires owner");
      }
      if (!existing.assignedToUserId && dto.assignedToUserId === undefined) {
        throw new ConflictException("Work item owner is required by org policy");
      }
    }

    const dueDate = this.resolveDueDateForUpdate(
      existing.dueDate,
      dto.dueDate,
      policy.defaultWorkDueDays,
      policy.requireWorkDueDate
    );

    const nextStatus = dto.status ?? existing.status;
    const updated = await this.prisma.workItem.update({
      where: { id: existing.id },
      data: {
        title: dto.title,
        description: dto.description,
        status: dto.status,
        priority: dto.priority,
        dueDate,
        assignedToUserId: dto.assignedToUserId,
        companyId: dto.companyId,
        dealId: dto.dealId,
        completedAt:
          nextStatus === WorkItemStatus.DONE
            ? existing.completedAt ?? new Date()
            : dto.status
              ? null
              : undefined
      }
    });

    await this.activityLogService.log({
      orgId: authUser.orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.WORK_ITEM,
      entityId: updated.id,
      action: "UPDATE",
      before: existing,
      after: updated
    });

    if (policy.requireWorkDueDate && !existing.dueDate && dueDate) {
      await this.activityLogService.log({
        orgId: authUser.orgId,
        actorUserId: authUser.userId,
        entityType: ActivityEntityType.WORK_ITEM,
        entityId: updated.id,
        action: "AUTO_DUE_DATE_SET",
        after: { dueDate }
      });
    }

    return updated;
  }

  async transition(id: string, dto: TransitionWorkItemDto, authUser: AuthUserContext) {
    const existing = await this.prisma.workItem.findFirst({
      where: { id, orgId: authUser.orgId }
    });

    if (!existing) {
      throw new NotFoundException("Work item not found");
    }

    const updated = await this.prisma.workItem.update({
      where: { id: existing.id },
      data: {
        status: dto.status,
        completedAt:
          dto.status === WorkItemStatus.DONE
            ? existing.completedAt ?? new Date()
            : null
      }
    });

    await this.activityLogService.log({
      orgId: authUser.orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.WORK_ITEM,
      entityId: updated.id,
      action: "TRANSITION",
      before: existing,
      after: updated
    });

    return updated;
  }

  async complete(id: string, authUser: AuthUserContext) {
    const existing = await this.prisma.workItem.findFirst({
      where: { id, orgId: authUser.orgId }
    });

    if (!existing) {
      throw new NotFoundException("Work item not found");
    }

    const updated = await this.prisma.workItem.update({
      where: { id: existing.id },
      data: {
        status: WorkItemStatus.DONE,
        completedAt: existing.completedAt ?? new Date()
      }
    });

    await this.activityLogService.log({
      orgId: authUser.orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.WORK_ITEM,
      entityId: updated.id,
      action: "COMPLETE",
      before: existing,
      after: updated
    });

    return updated;
  }

  async listActivity(id: string, authUser: AuthUserContext, query: PaginationQueryDto) {
    const sortBy = this.resolveActivitySortField(query.sortBy);
    const skip = (query.page - 1) * query.pageSize;
    const exists = await this.prisma.workItem.findFirst({
      where: { id, orgId: authUser.orgId },
      select: { id: true }
    });
    if (!exists) {
      throw new NotFoundException("Work item not found");
    }

    const where: Prisma.ActivityLogWhereInput = {
      orgId: authUser.orgId,
      entityType: ActivityEntityType.WORK_ITEM,
      entityId: id
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.activityLog.findMany({
        where,
        orderBy: [{ [sortBy]: query.sortDir }, { id: "asc" }],
        skip,
        take: query.pageSize,
        include: {
          actorUser: {
            select: { id: true, name: true, email: true }
          }
        }
      }),
      this.prisma.activityLog.count({ where })
    ]);

    return toPaginatedResponse(items, query.page, query.pageSize, total);
  }

  private async ensureUserInOrg(userId: string | null | undefined, orgId: string): Promise<void> {
    if (!userId) {
      return;
    }
    const user = await this.prisma.user.findFirst({
      where: { id: userId, orgId, isActive: true }
    });
    if (!user) {
      throw new BadRequestException("Assigned user not found in org");
    }
  }

  private async ensureCompanyInOrg(
    companyId: string | null | undefined,
    orgId: string
  ): Promise<void> {
    if (!companyId) {
      return;
    }
    const company = await this.prisma.company.findFirst({
      where: { id: companyId, orgId }
    });
    if (!company) {
      throw new BadRequestException("Company not found in org");
    }
  }

  private async ensureDealInOrg(dealId: string | null | undefined, orgId: string): Promise<void> {
    if (!dealId) {
      return;
    }
    const deal = await this.prisma.deal.findFirst({
      where: { id: dealId, orgId }
    });
    if (!deal) {
      throw new BadRequestException("Deal not found in org");
    }
  }

  private resolveSortField(
    sortBy?: string
  ): "createdAt" | "dueDate" | "status" | "priority" | "title" {
    if (!sortBy) {
      return "createdAt";
    }
    if (
      sortBy === "createdAt" ||
      sortBy === "dueDate" ||
      sortBy === "status" ||
      sortBy === "priority" ||
      sortBy === "title"
    ) {
      return sortBy;
    }
    throw new BadRequestException("Invalid sortBy for work-items");
  }

  private resolveActivitySortField(sortBy?: string): "createdAt" | "action" {
    if (!sortBy) {
      return "createdAt";
    }
    if (sortBy === "createdAt" || sortBy === "action") {
      return sortBy;
    }
    throw new BadRequestException("Invalid sortBy for activity");
  }

  private resolveDueDateForCreate(
    input: string | null | undefined,
    defaultWorkDueDays: number,
    requireWorkDueDate: boolean
  ): Date | null {
    if (input) {
      const dueDate = new Date(input);
      this.assertDueDateNotPast(dueDate);
      return dueDate;
    }

    if (!requireWorkDueDate) {
      return null;
    }

    if (defaultWorkDueDays < 0) {
      throw new ConflictException("Work item due date is required by org policy");
    }

    return this.defaultDueDate(defaultWorkDueDays);
  }

  private resolveDueDateForUpdate(
    existingDueDate: Date | null,
    input: string | null | undefined,
    defaultWorkDueDays: number,
    requireWorkDueDate: boolean
  ): Date | null | undefined {
    if (input === undefined) {
      if (!requireWorkDueDate || existingDueDate) {
        return undefined;
      }
      if (defaultWorkDueDays < 0) {
        throw new ConflictException("Work item due date is required by org policy");
      }
      return this.defaultDueDate(defaultWorkDueDays);
    }

    if (input === null) {
      if (!requireWorkDueDate) {
        return null;
      }
      if (defaultWorkDueDays < 0) {
        throw new ConflictException("Work item due date is required by org policy");
      }
      return this.defaultDueDate(defaultWorkDueDays);
    }

    const dueDate = new Date(input);
    this.assertDueDateNotPast(dueDate);
    return dueDate;
  }

  private assertDueDateNotPast(value: Date): void {
    const today = startOfDay(new Date());
    const dueDate = startOfDay(value);
    if (dueDate < today) {
      throw new ConflictException("Work item due date cannot be in the past");
    }
  }

  private defaultDueDate(defaultWorkDueDays: number): Date {
    const today = startOfDay(new Date());
    const dueDate = new Date(today);
    dueDate.setUTCDate(today.getUTCDate() + defaultWorkDueDays);
    return dueDate;
  }
}
