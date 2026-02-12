import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ActivityEntityType, DealStage, WorkItemStatus } from "@prisma/client";
import { ActivityLogService } from "../activity-log/activity-log.service";
import { AuthUserContext } from "../auth/auth.types";
import { toPaginatedResponse } from "../common/dto/paginated-response.dto";
import { PrismaService } from "../prisma/prisma.service";
import { CreateDealDto } from "./dto/create-deal.dto";
import { ListDealsDto } from "./dto/list-deals.dto";
import { UpdateDealDto } from "./dto/update-deal.dto";

@Injectable()
export class DealsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLogService: ActivityLogService
  ) {}

  async findAll(authUser: AuthUserContext, query: ListDealsDto) {
    const sortBy = this.resolveSortField(query.sortBy);
    const skip = (query.page - 1) * query.pageSize;
    const where = {
      orgId: authUser.orgId,
      stage: query.stage,
      companyId: query.companyId
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.deal.findMany({
        where,
        orderBy: [{ [sortBy]: query.sortDir }, { id: "asc" }],
        skip,
        take: query.pageSize,
        include: {
          company: {
            select: {
              id: true,
              name: true
            }
          },
          owner: {
            select: {
              id: true,
              name: true
            }
          }
        }
      }),
      this.prisma.deal.count({ where })
    ]);

    return toPaginatedResponse(items, query.page, query.pageSize, total);
  }

  async create(dto: CreateDealDto, authUser: AuthUserContext) {
    await this.ensureCompanyInOrg(dto.companyId, authUser.orgId);
    await this.ensureOwnerInOrg(dto.ownerUserId, authUser.orgId);

    const created = await this.prisma.deal.create({
      data: {
        orgId: authUser.orgId,
        title: dto.title,
        companyId: dto.companyId,
        ownerUserId: dto.ownerUserId,
        valueAmount: dto.valueAmount ?? 0,
        currency: dto.currency ?? "INR",
        expectedCloseDate: dto.expectedCloseDate ? new Date(dto.expectedCloseDate) : null,
        stage: dto.stage ?? DealStage.OPEN
      }
    });

    await this.activityLogService.log({
      orgId: authUser.orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.DEAL,
      entityId: created.id,
      action: "CREATE",
      after: created
    });

    return created;
  }

  async update(id: string, dto: UpdateDealDto, authUser: AuthUserContext) {
    const existing = await this.prisma.deal.findFirst({
      where: { id, orgId: authUser.orgId }
    });

    if (!existing) {
      throw new NotFoundException("Deal not found");
    }

    if (dto.companyId) {
      await this.ensureCompanyInOrg(dto.companyId, authUser.orgId);
    }
    await this.ensureOwnerInOrg(dto.ownerUserId, authUser.orgId);

    const updated = await this.prisma.deal.update({
      where: { id: existing.id },
      data: {
        title: dto.title,
        companyId: dto.companyId,
        ownerUserId: dto.ownerUserId,
        valueAmount: dto.valueAmount,
        currency: dto.currency,
        expectedCloseDate: dto.expectedCloseDate ? new Date(dto.expectedCloseDate) : undefined,
        stage: dto.stage
      }
    });

    await this.activityLogService.log({
      orgId: authUser.orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.DEAL,
      entityId: updated.id,
      action: "UPDATE",
      before: existing,
      after: updated
    });

    return updated;
  }

  async markWon(id: string, authUser: AuthUserContext) {
    const existing = await this.findDealOr404(id, authUser.orgId);

    const updated = await this.prisma.deal.update({
      where: { id: existing.id },
      data: {
        stage: DealStage.WON,
        wonAt: new Date()
      }
    });

    const existingWorkItem = await this.prisma.workItem.findFirst({
      where: {
        orgId: authUser.orgId,
        dealId: existing.id
      }
    });

    if (!existingWorkItem) {
      const rootWorkItem = await this.prisma.workItem.create({
        data: {
          orgId: authUser.orgId,
          title: `Deliver: ${existing.title}`,
          status: WorkItemStatus.TODO,
          dueDate: existing.expectedCloseDate ? this.toDateOnly(existing.expectedCloseDate) : null,
          createdByUserId: authUser.userId,
          companyId: existing.companyId,
          dealId: existing.id
        }
      });

      await this.activityLogService.log({
        orgId: authUser.orgId,
        actorUserId: authUser.userId,
        entityType: ActivityEntityType.WORK_ITEM,
        entityId: rootWorkItem.id,
        action: "CREATE",
        after: rootWorkItem
      });
    }

    await this.activityLogService.log({
      orgId: authUser.orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.DEAL,
      entityId: updated.id,
      action: "MARK_WON",
      before: existing,
      after: updated
    });

    return updated;
  }

  async markLost(id: string, authUser: AuthUserContext) {
    const existing = await this.findDealOr404(id, authUser.orgId);

    const updated = await this.prisma.deal.update({
      where: { id: existing.id },
      data: {
        stage: DealStage.LOST,
        wonAt: null
      }
    });

    await this.activityLogService.log({
      orgId: authUser.orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.DEAL,
      entityId: updated.id,
      action: "MARK_LOST",
      before: existing,
      after: updated
    });

    return updated;
  }

  private async findDealOr404(id: string, orgId: string) {
    const deal = await this.prisma.deal.findFirst({
      where: { id, orgId }
    });

    if (!deal) {
      throw new NotFoundException("Deal not found");
    }

    return deal;
  }

  private async ensureCompanyInOrg(companyId: string, orgId: string): Promise<void> {
    const company = await this.prisma.company.findFirst({
      where: { id: companyId, orgId }
    });

    if (!company) {
      throw new BadRequestException("Company not found in org");
    }
  }

  private async ensureOwnerInOrg(ownerUserId: string | undefined, orgId: string): Promise<void> {
    if (!ownerUserId) {
      return;
    }

    const owner = await this.prisma.user.findFirst({
      where: { id: ownerUserId, orgId }
    });

    if (!owner) {
      throw new BadRequestException("Owner user not found in org");
    }
  }

  private toDateOnly(value: Date): Date {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }

  private resolveSortField(
    sortBy?: string
  ): "createdAt" | "title" | "stage" | "valueAmount" | "expectedCloseDate" {
    if (!sortBy) {
      return "createdAt";
    }
    if (
      sortBy === "createdAt" ||
      sortBy === "title" ||
      sortBy === "stage" ||
      sortBy === "valueAmount" ||
      sortBy === "expectedCloseDate"
    ) {
      return sortBy;
    }
    throw new BadRequestException("Invalid sortBy for deals");
  }
}
