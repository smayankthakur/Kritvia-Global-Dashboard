import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { ActivityEntityType, DealStage, WorkItemStatus } from "@prisma/client";
import { ActivityLogService } from "../activity-log/activity-log.service";
import { AuthUserContext } from "../auth/auth.types";
import { toPaginatedResponse } from "../common/dto/paginated-response.dto";
import { PrismaService } from "../prisma/prisma.service";
import { PolicyResolverService } from "../policy/policy-resolver.service";
import { WEBHOOK_EVENTS } from "../org-webhooks/webhook-events";
import { WebhookService } from "../org-webhooks/webhook.service";
import { CreateDealDto } from "./dto/create-deal.dto";
import { ListDealsDto } from "./dto/list-deals.dto";
import { UpdateDealDto } from "./dto/update-deal.dto";

@Injectable()
export class DealsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLogService: ActivityLogService,
    private readonly policyResolverService: PolicyResolverService,
    private readonly webhookService: WebhookService
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
    const policy = await this.policyResolverService.getPolicyForOrg(authUser.orgId);
    if (policy.requireDealOwner && !dto.ownerUserId) {
      throw new ConflictException("Deal owner is required by org policy");
    }

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
    void this.webhookService.dispatch(authUser.orgId, WEBHOOK_EVENTS.DEAL_CREATED, {
      orgId: authUser.orgId,
      dealId: created.id,
      title: created.title,
      stage: created.stage,
      valueAmount: created.valueAmount,
      currency: created.currency,
      companyId: created.companyId,
      ownerUserId: created.ownerUserId,
      occurredAt: new Date().toISOString()
    });

    return created;
  }

  async update(id: string, dto: UpdateDealDto, authUser: AuthUserContext) {
    const policy = await this.policyResolverService.getPolicyForOrg(authUser.orgId);
    const existing = await this.prisma.deal.findFirst({
      where: { id, orgId: authUser.orgId }
    });

    if (!existing) {
      throw new NotFoundException("Deal not found");
    }

    if (dto.companyId) {
      await this.ensureCompanyInOrg(dto.companyId, authUser.orgId);
    }

    if (policy.requireDealOwner) {
      if (dto.ownerUserId === null) {
        throw new ConflictException("Deal owner cannot be unset while policy requires owner");
      }
      if (!existing.ownerUserId && dto.ownerUserId === undefined) {
        throw new ConflictException("Deal owner is required by org policy");
      }
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
    void this.webhookService.dispatch(authUser.orgId, WEBHOOK_EVENTS.DEAL_UPDATED, {
      orgId: authUser.orgId,
      dealId: updated.id,
      stage: updated.stage,
      valueAmount: updated.valueAmount,
      currency: updated.currency,
      expectedCloseDate: updated.expectedCloseDate?.toISOString() ?? null,
      occurredAt: new Date().toISOString()
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

  private async ensureOwnerInOrg(ownerUserId: string | null | undefined, orgId: string): Promise<void> {
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
