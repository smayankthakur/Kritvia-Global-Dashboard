import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ActivityEntityType, Prisma } from "@prisma/client";
import { ActivityLogService } from "../activity-log/activity-log.service";
import { AuthUserContext } from "../auth/auth.types";
import { PaginationQueryDto } from "../common/dto/pagination-query.dto";
import { toPaginatedResponse } from "../common/dto/paginated-response.dto";
import { PrismaService } from "../prisma/prisma.service";
import { CreateCompanyDto } from "./dto/create-company.dto";
import { UpdateCompanyDto } from "./dto/update-company.dto";

@Injectable()
export class CompaniesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLogService: ActivityLogService
  ) {}

  async findAll(authUser: AuthUserContext, query: PaginationQueryDto) {
    const sortBy = this.resolveSortField(query.sortBy);
    const skip = (query.page - 1) * query.pageSize;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.company.findMany({
        where: { orgId: authUser.orgId },
        orderBy: [{ [sortBy]: query.sortDir }, { id: "asc" }],
        skip,
        take: query.pageSize,
        select: {
          id: true,
          name: true,
          industry: true,
          website: true,
          ownerUserId: true,
          createdAt: true,
          owner: {
            select: {
              id: true,
              name: true,
              email: true
            }
          }
        }
      }),
      this.prisma.company.count({
        where: { orgId: authUser.orgId }
      })
    ]);

    return toPaginatedResponse(items, query.page, query.pageSize, total);
  }

  async findOne(id: string, authUser: AuthUserContext) {
    const company = await this.prisma.company.findFirst({
      where: {
        id,
        orgId: authUser.orgId
      },
      select: {
        id: true,
        name: true,
        industry: true,
        website: true,
        ownerUserId: true,
        createdAt: true,
        owner: {
          select: {
            id: true,
            name: true,
            email: true
          }
        }
      }
    });

    if (!company) {
      throw new NotFoundException("Company not found");
    }

    return company;
  }

  async create(dto: CreateCompanyDto, authUser: AuthUserContext) {
    await this.ensureOwnerInOrg(dto.ownerUserId, authUser.orgId);

    try {
      const company = await this.prisma.company.create({
        data: {
          orgId: authUser.orgId,
          name: dto.name,
          industry: dto.industry,
          website: dto.website,
          ownerUserId: dto.ownerUserId
        }
      });

      await this.activityLogService.log({
        orgId: authUser.orgId,
        actorUserId: authUser.userId,
        entityType: ActivityEntityType.COMPANY,
        entityId: company.id,
        action: "CREATE",
        after: company
      });

      return company;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new BadRequestException("Company with same name already exists in org");
      }
      throw error;
    }
  }

  async update(id: string, dto: UpdateCompanyDto, authUser: AuthUserContext) {
    const existing = await this.prisma.company.findFirst({
      where: {
        id,
        orgId: authUser.orgId
      }
    });

    if (!existing) {
      throw new NotFoundException("Company not found");
    }

    await this.ensureOwnerInOrg(dto.ownerUserId, authUser.orgId);

    try {
      const updated = await this.prisma.company.update({
        where: { id: existing.id },
        data: {
          name: dto.name,
          industry: dto.industry,
          website: dto.website,
          ownerUserId: dto.ownerUserId
        }
      });

      await this.activityLogService.log({
        orgId: authUser.orgId,
        actorUserId: authUser.userId,
        entityType: ActivityEntityType.COMPANY,
        entityId: updated.id,
        action: "UPDATE",
        before: existing,
        after: updated
      });

      return updated;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new BadRequestException("Company with same name already exists in org");
      }
      throw error;
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

  private resolveSortField(sortBy?: string): "createdAt" | "name" | "industry" {
    if (!sortBy) {
      return "createdAt";
    }
    if (sortBy === "createdAt" || sortBy === "name" || sortBy === "industry") {
      return sortBy;
    }
    throw new BadRequestException("Invalid sortBy for companies");
  }
}
