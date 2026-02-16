import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ActivityEntityType } from "@prisma/client";
import { ActivityLogService } from "../activity-log/activity-log.service";
import { AuthUserContext } from "../auth/auth.types";
import { toPaginatedResponse } from "../common/dto/paginated-response.dto";
import { PrismaService } from "../prisma/prisma.service";
import { CreateContactDto } from "./dto/create-contact.dto";
import { ListCompanyContactsDto } from "./dto/list-company-contacts.dto";
import { UpdateContactDto } from "./dto/update-contact.dto";

@Injectable()
export class ContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLogService: ActivityLogService
  ) {}

  async findByCompany(
    companyId: string,
    query: ListCompanyContactsDto,
    authUser: AuthUserContext
  ) {
    const company = await this.prisma.company.findFirst({
      where: {
        id: companyId,
        orgId: authUser.orgId
      }
    });

    if (!company) {
      throw new NotFoundException("Company not found");
    }

    const skip = (query.page - 1) * query.pageSize;
    const where = {
      orgId: authUser.orgId,
      companyId
    };
    const sortBy = query.sortBy ?? "createdAt";

    const [items, total] = await this.prisma.$transaction([
      this.prisma.contact.findMany({
        where,
        orderBy: [{ [sortBy]: query.sortDir }, { id: "asc" }],
        skip,
        take: query.pageSize
      }),
      this.prisma.contact.count({ where })
    ]);

    return toPaginatedResponse(items, query.page, query.pageSize, total);
  }

  async create(dto: CreateContactDto, authUser: AuthUserContext) {
    await this.ensureCompanyInOrg(dto.companyId, authUser.orgId);
    await this.ensureOwnerInOrg(dto.ownerUserId, authUser.orgId);

    const created = await this.prisma.contact.create({
      data: {
        orgId: authUser.orgId,
        companyId: dto.companyId,
        name: dto.name,
        email: dto.email,
        phone: dto.phone,
        title: dto.title,
        ownerUserId: dto.ownerUserId
      }
    });

    await this.activityLogService.log({
      orgId: authUser.orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.CONTACT,
      entityId: created.id,
      action: "CREATE",
      after: created
    });

    return created;
  }

  async update(id: string, dto: UpdateContactDto, authUser: AuthUserContext) {
    const existing = await this.prisma.contact.findFirst({
      where: {
        id,
        orgId: authUser.orgId
      }
    });

    if (!existing) {
      throw new NotFoundException("Contact not found");
    }

    if (dto.companyId) {
      await this.ensureCompanyInOrg(dto.companyId, authUser.orgId);
    }
    await this.ensureOwnerInOrg(dto.ownerUserId, authUser.orgId);

    const updated = await this.prisma.contact.update({
      where: { id: existing.id },
      data: {
        companyId: dto.companyId,
        name: dto.name,
        email: dto.email,
        phone: dto.phone,
        title: dto.title,
        ownerUserId: dto.ownerUserId
      }
    });

    await this.activityLogService.log({
      orgId: authUser.orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.CONTACT,
      entityId: updated.id,
      action: "UPDATE",
      before: existing,
      after: updated
    });

    return updated;
  }

  private async ensureCompanyInOrg(companyId: string, orgId: string): Promise<void> {
    const company = await this.prisma.company.findFirst({
      where: {
        id: companyId,
        orgId
      }
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
      where: {
        id: ownerUserId,
        orgId
      }
    });

    if (!owner) {
      throw new BadRequestException("Owner user not found in org");
    }
  }
}
