import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ActivityEntityType, DealStage, LeadStage } from "@prisma/client";
import { ActivityLogService } from "../activity-log/activity-log.service";
import { AuthUserContext } from "../auth/auth.types";
import { toPaginatedResponse } from "../common/dto/paginated-response.dto";
import { PrismaService } from "../prisma/prisma.service";
import { ConvertLeadToDealDto, CreateLeadDto } from "./dto/create-lead.dto";
import { ListLeadsDto } from "./dto/list-leads.dto";
import { UpdateLeadDto } from "./dto/update-lead.dto";

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLogService: ActivityLogService
  ) {}

  async findAll(authUser: AuthUserContext, query: ListLeadsDto) {
    const sortBy = this.resolveSortField(query.sortBy);
    const skip = (query.page - 1) * query.pageSize;
    const where = {
      orgId: authUser.orgId,
      stage: query.stage
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.lead.findMany({
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
      this.prisma.lead.count({ where })
    ]);

    return toPaginatedResponse(items, query.page, query.pageSize, total);
  }

  async create(dto: CreateLeadDto, authUser: AuthUserContext) {
    await this.validateCompanyContactOwner(
      dto.companyId,
      dto.contactId,
      dto.ownerUserId,
      authUser.orgId
    );

    const created = await this.prisma.lead.create({
      data: {
        orgId: authUser.orgId,
        title: dto.title,
        stage: dto.stage ?? LeadStage.NEW,
        source: dto.source,
        notes: dto.notes,
        companyId: dto.companyId,
        contactId: dto.contactId,
        ownerUserId: dto.ownerUserId
      }
    });

    await this.activityLogService.log({
      orgId: authUser.orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.LEAD,
      entityId: created.id,
      action: "CREATE",
      after: created
    });

    return created;
  }

  async update(id: string, dto: UpdateLeadDto, authUser: AuthUserContext) {
    const existing = await this.prisma.lead.findFirst({
      where: { id, orgId: authUser.orgId }
    });

    if (!existing) {
      throw new NotFoundException("Lead not found");
    }

    await this.validateCompanyContactOwner(
      dto.companyId,
      dto.contactId,
      dto.ownerUserId,
      authUser.orgId
    );

    const updated = await this.prisma.lead.update({
      where: { id: existing.id },
      data: {
        title: dto.title,
        stage: dto.stage,
        source: dto.source,
        notes: dto.notes,
        companyId: dto.companyId,
        contactId: dto.contactId,
        ownerUserId: dto.ownerUserId
      }
    });

    await this.activityLogService.log({
      orgId: authUser.orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.LEAD,
      entityId: updated.id,
      action: "UPDATE",
      before: existing,
      after: updated
    });

    return updated;
  }

  async convertToDeal(id: string, dto: ConvertLeadToDealDto, authUser: AuthUserContext) {
    const lead = await this.prisma.lead.findFirst({
      where: {
        id,
        orgId: authUser.orgId
      }
    });

    if (!lead) {
      throw new NotFoundException("Lead not found");
    }

    const targetCompanyId = lead.companyId ?? dto.companyId;
    if (!targetCompanyId) {
      throw new BadRequestException("companyId is required when lead has no company");
    }

    await this.ensureCompanyInOrg(targetCompanyId, authUser.orgId);
    if (dto.contactId) {
      await this.ensureContactInOrg(dto.contactId, authUser.orgId);
    } else if (lead.contactId) {
      await this.ensureContactInOrg(lead.contactId, authUser.orgId);
    }
    await this.ensureOwnerInOrg(dto.ownerUserId, authUser.orgId);

    const deal = await this.prisma.deal.create({
      data: {
        orgId: authUser.orgId,
        title: lead.title,
        stage: DealStage.OPEN,
        companyId: targetCompanyId,
        ownerUserId: dto.ownerUserId ?? lead.ownerUserId,
        valueAmount: dto.valueAmount ?? 0,
        currency: dto.currency ?? "INR",
        expectedCloseDate: dto.expectedCloseDate ? new Date(dto.expectedCloseDate) : null
      }
    });

    await this.activityLogService.log({
      orgId: authUser.orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.LEAD,
      entityId: lead.id,
      action: "CONVERT",
      before: lead,
      after: {
        dealId: deal.id,
        dealStage: deal.stage,
        companyId: deal.companyId,
        contactId: dto.contactId ?? lead.contactId ?? null
      }
    });

    return deal;
  }

  private async validateCompanyContactOwner(
    companyId: string | undefined,
    contactId: string | undefined,
    ownerUserId: string | undefined,
    orgId: string
  ): Promise<void> {
    if (companyId) {
      await this.ensureCompanyInOrg(companyId, orgId);
    }

    if (contactId) {
      await this.ensureContactInOrg(contactId, orgId);
    }

    await this.ensureOwnerInOrg(ownerUserId, orgId);
  }

  private async ensureCompanyInOrg(companyId: string, orgId: string): Promise<void> {
    const company = await this.prisma.company.findFirst({
      where: { id: companyId, orgId }
    });

    if (!company) {
      throw new BadRequestException("Company not found in org");
    }
  }

  private async ensureContactInOrg(contactId: string, orgId: string): Promise<void> {
    const contact = await this.prisma.contact.findFirst({
      where: { id: contactId, orgId }
    });

    if (!contact) {
      throw new BadRequestException("Contact not found in org");
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

  private resolveSortField(sortBy?: string): "createdAt" | "title" | "stage" {
    if (!sortBy) {
      return "createdAt";
    }
    if (sortBy === "createdAt" || sortBy === "title" || sortBy === "stage") {
      return sortBy;
    }
    throw new BadRequestException("Invalid sortBy for leads");
  }
}
