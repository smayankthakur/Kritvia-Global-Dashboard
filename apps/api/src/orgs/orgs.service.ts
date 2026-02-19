import { ConflictException, ForbiddenException, Injectable } from "@nestjs/common";
import { ActivityEntityType, Role } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { ActivityLogService } from "../activity-log/activity-log.service";
import { AuthUserContext } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { CreateOrgDto } from "./dto/create-org.dto";

function normalizeSlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

@Injectable()
export class OrgsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLogService: ActivityLogService
  ) {}

  async create(authUser: AuthUserContext, dto: CreateOrgDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: authUser.userId },
      select: { id: true, email: true, isActive: true, name: true }
    });

    if (!user || !user.isActive) {
      throw new ForbiddenException("Only active users can create organizations");
    }

    const activeMembership = await this.prisma.orgMember.findFirst({
      where: {
        userId: authUser.userId,
        status: "ACTIVE"
      },
      select: { id: true }
    });

    if (!activeMembership) {
      throw new ForbiddenException("Only active org members can create organizations");
    }

    const requestedBase = normalizeSlug(dto.slug ?? dto.name);
    if (!requestedBase) {
      throw new ConflictException("Unable to generate a valid organization slug");
    }

    const slug = await this.ensureUniqueSlug(requestedBase);

    const created = await this.prisma.$transaction(async (tx) => {
      const org = await tx.org.create({
        data: {
          name: dto.name,
          slug
        },
        select: {
          id: true,
          name: true,
          slug: true
        }
      });

      const membership = await tx.orgMember.create({
        data: {
          orgId: org.id,
          userId: user.id,
          email: user.email,
          role: Role.CEO,
          status: "ACTIVE",
          joinedAt: new Date()
        },
        select: {
          role: true,
          status: true
        }
      });

      await tx.policy.upsert({
        where: { orgId: org.id },
        update: {},
        create: {
          orgId: org.id
        }
      });

      return { org, membership };
    });

    await this.activityLogService.log({
      orgId: created.org.id,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.AUTH,
      entityId: created.org.id,
      action: "ORG_CREATE",
      after: {
        orgId: created.org.id,
        name: created.org.name,
        slug: created.org.slug
      }
    });

    return created;
  }

  private async ensureUniqueSlug(baseSlug: string): Promise<string> {
    const existing = await this.prisma.org.findUnique({
      where: { slug: baseSlug },
      select: { id: true }
    });
    if (!existing) {
      return baseSlug;
    }

    for (let suffix = 2; suffix <= 999; suffix += 1) {
      const candidate = `${baseSlug}-${suffix}`;
      const collision = await this.prisma.org.findUnique({
        where: { slug: candidate },
        select: { id: true }
      });
      if (!collision) {
        return candidate;
      }
    }

    const fallback = `${baseSlug}-${randomBytes(3).toString("hex")}`;
    return fallback;
  }
}
