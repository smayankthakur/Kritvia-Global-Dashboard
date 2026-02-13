import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { ActivityEntityType, Prisma, Role } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { ActivityLogService } from "../activity-log/activity-log.service";
import { AuthUserContext } from "../auth/auth.types";
import { toPaginatedResponse } from "../common/dto/paginated-response.dto";
import { PrismaService } from "../prisma/prisma.service";
import { CreateUserDto } from "./dto/create-user.dto";
import { ListUsersDto } from "./dto/list-users.dto";
import { UpdateUserDto } from "./dto/update-user.dto";

const { hash } = require("bcryptjs") as {
  hash: (plainText: string, rounds: number) => Promise<string>;
};

interface SafeUserRecord {
  id: string;
  name: string;
  email: string;
  role: Role;
  isActive: boolean;
  createdAt: Date;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLogService: ActivityLogService
  ) {}

  async findAll(authUser: AuthUserContext, query: ListUsersDto) {
    const sortBy = this.resolveSortField(query.sortBy);
    const skip = (query.page - 1) * query.pageSize;
    const where = {
      orgId: authUser.orgId,
      ...(query.active === "all"
        ? {}
        : {
            isActive: query.active === "active"
          })
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        orderBy: [{ [sortBy]: query.sortDir }, { id: "asc" }],
        skip,
        take: query.pageSize,
        select: this.safeUserSelect()
      }),
      this.prisma.user.count({ where })
    ]);

    return toPaginatedResponse(items, query.page, query.pageSize, total);
  }

  async create(dto: CreateUserDto, authUser: AuthUserContext) {
    this.assertCanSetRole(authUser, dto.role);
    const normalizedEmail = dto.email.trim().toLowerCase();

    const password = dto.password?.trim() || this.generateTempPassword();
    const passwordHash = await hash(password, 10);

    try {
      const created = await this.prisma.user.create({
        data: {
          orgId: authUser.orgId,
          name: dto.name,
          email: normalizedEmail,
          role: dto.role,
          isActive: true,
          passwordHash
        },
        select: this.safeUserSelect()
      });

      await this.activityLogService.log({
        orgId: authUser.orgId,
        actorUserId: authUser.userId,
        entityType: ActivityEntityType.USER,
        entityId: created.id,
        action: "USER_CREATE",
        after: created
      });

      return {
        user: created,
        ...(dto.password ? {} : { tempPassword: password })
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("User with this email already exists");
      }
      throw error;
    }
  }

  async update(id: string, dto: UpdateUserDto, authUser: AuthUserContext) {
    const existing = await this.getUserInOrg(id, authUser.orgId);
    this.assertCanSetRole(authUser, dto.role);

    if (dto.role && existing.id === authUser.userId && dto.role !== existing.role) {
      throw new ConflictException("Cannot change your own role");
    }

    const updated = await this.prisma.user.update({
      where: { id: existing.id },
      data: {
        name: dto.name,
        role: dto.role
      },
      select: this.safeUserSelect()
    });

    await this.activityLogService.log({
      orgId: authUser.orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.USER,
      entityId: updated.id,
      action: "USER_UPDATE",
      before: this.toSafeUserRecord(existing),
      after: updated
    });

    return updated;
  }

  async deactivate(id: string, authUser: AuthUserContext) {
    const existing = await this.getUserInOrg(id, authUser.orgId);
    if (existing.id === authUser.userId) {
      throw new BadRequestException("You cannot deactivate your own account");
    }
    if (!existing.isActive) {
      return this.toSafeUserRecord(existing);
    }

    const updated = await this.prisma.user.update({
      where: { id: existing.id },
      data: { isActive: false },
      select: this.safeUserSelect()
    });

    await this.activityLogService.log({
      orgId: authUser.orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.USER,
      entityId: updated.id,
      action: "USER_DEACTIVATE",
      before: this.toSafeUserRecord(existing),
      after: updated
    });

    return updated;
  }

  async reactivate(id: string, authUser: AuthUserContext) {
    const existing = await this.getUserInOrg(id, authUser.orgId);
    if (existing.isActive) {
      return this.toSafeUserRecord(existing);
    }

    const updated = await this.prisma.user.update({
      where: { id: existing.id },
      data: { isActive: true },
      select: this.safeUserSelect()
    });

    await this.activityLogService.log({
      orgId: authUser.orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.USER,
      entityId: updated.id,
      action: "USER_REACTIVATE",
      before: this.toSafeUserRecord(existing),
      after: updated
    });

    return updated;
  }

  private async getUserInOrg(id: string, orgId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, orgId }
    });
    if (!user) {
      throw new NotFoundException("User not found");
    }
    return user;
  }

  private assertCanSetRole(authUser: AuthUserContext, nextRole?: Role): void {
    if (!nextRole) {
      return;
    }
    if (authUser.role === Role.CEO && nextRole === Role.ADMIN) {
      throw new ForbiddenException("CEO cannot assign ADMIN role");
    }
  }

  private resolveSortField(
    sortBy?: string
  ): "createdAt" | "name" | "email" | "role" | "isActive" {
    if (!sortBy) {
      return "createdAt";
    }
    if (
      sortBy === "createdAt" ||
      sortBy === "name" ||
      sortBy === "email" ||
      sortBy === "role" ||
      sortBy === "isActive"
    ) {
      return sortBy;
    }
    throw new BadRequestException("Invalid sortBy for users");
  }

  private safeUserSelect() {
    return {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      createdAt: true
    } as const;
  }

  private toSafeUserRecord(user: {
    id: string;
    name: string;
    email: string;
    role: Role;
    isActive: boolean;
    createdAt: Date;
  }): SafeUserRecord {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      isActive: user.isActive,
      createdAt: user.createdAt
    };
  }

  private generateTempPassword(): string {
    const alphabet =
      "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
    const random = randomBytes(18);
    let password = "";
    for (let index = 0; index < 14; index += 1) {
      password += alphabet[random[index] % alphabet.length];
    }
    return password;
  }
}
