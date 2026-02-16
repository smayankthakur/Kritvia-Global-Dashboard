import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ActivityEntityType, Role } from "@prisma/client";
import { StringValue } from "ms";
import { createHash, randomBytes } from "node:crypto";
import { hash } from "bcryptjs";
import { ActivityLogService } from "../activity-log/activity-log.service";
import { AuthUserContext, AuthTokenPayload } from "../auth/auth.types";
import { BillingService } from "../billing/billing.service";
import { getActiveOrgId } from "../common/auth-org";
import { PrismaService } from "../prisma/prisma.service";
import { AcceptOrgInviteDto, AcceptOrgInviteResponse } from "./dto/accept-org-invite.dto";
import { InviteOrgMemberDto } from "./dto/invite-org-member.dto";
import { UpdateOrgMemberDto } from "./dto/update-org-member.dto";

const INVITE_WINDOW_MS = 48 * 60 * 60 * 1000;
const INVITE_DAILY_LIMIT = 20;

@Injectable()
export class OrgMembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLogService: ActivityLogService,
    private readonly jwtService: JwtService,
    private readonly billingService: BillingService
  ) {}

  async listMembers(authUser: AuthUserContext) {
    const activeOrgId = authUser.activeOrgId ?? authUser.orgId;

    const members = await this.prisma.orgMember.findMany({
      where: {
        orgId: activeOrgId
      },
      orderBy: [{ createdAt: "asc" }],
      select: {
        userId: true,
        email: true,
        role: true,
        status: true,
        joinedAt: true,
        user: {
          select: {
            name: true
          }
        }
      }
    });

    return members.map((member) => ({
      userId: member.userId,
      name: member.user?.name ?? null,
      email: member.email,
      role: member.role,
      status: member.status,
      joinedAt: member.joinedAt
    }));
  }

  async getUsage(authUser: AuthUserContext) {
    const activeOrgId = getActiveOrgId({ user: authUser });
    return this.billingService.getUsageForOrg(activeOrgId);
  }

  async invite(authUser: AuthUserContext, dto: InviteOrgMemberDto) {
    const activeOrgId = getActiveOrgId({ user: authUser });
    const email = dto.email.trim().toLowerCase();

    await this.enforceInviteRateLimit(activeOrgId, authUser.userId);
    await this.billingService.assertSeatAvailable(activeOrgId);

    const existingMember = await this.prisma.orgMember.findUnique({
      where: {
        orgId_email: {
          orgId: activeOrgId,
          email
        }
      },
      select: {
        id: true,
        status: true,
        userId: true
      }
    });

    if (existingMember?.status === "ACTIVE") {
      throw new ConflictException("Already a member");
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true
      }
    });

    if (existingMember?.status === "INVITED") {
      await this.prisma.orgInviteToken.updateMany({
        where: {
          orgId: activeOrgId,
          email,
          usedAt: null
        },
        data: {
          usedAt: new Date()
        }
      });
    }

    const upsertedMember = await this.prisma.orgMember.upsert({
      where: {
        orgId_email: {
          orgId: activeOrgId,
          email
        }
      },
      create: {
        orgId: activeOrgId,
        userId: existingUser?.id,
        email,
        role: dto.role,
        status: "INVITED"
      },
      update: {
        userId: existingUser?.id ?? existingMember?.userId ?? null,
        role: dto.role,
        status: "INVITED"
      }
    });

    const rawToken = randomBytes(48).toString("base64url");
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + INVITE_WINDOW_MS);

    await this.prisma.orgInviteToken.create({
      data: {
        orgId: activeOrgId,
        email,
        role: dto.role,
        tokenHash,
        invitedByUserId: authUser.userId,
        expiresAt
      }
    });

    const webBaseUrl = process.env.WEB_BASE_URL || "http://localhost:3000";
    const inviteLink = `${webBaseUrl.replace(/\/$/, "")}/accept-invite?token=${encodeURIComponent(rawToken)}&orgId=${activeOrgId}`;

    await this.activityLogService.log({
      orgId: activeOrgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.USER,
      entityId: upsertedMember.id,
      action: "ORG_INVITE_CREATED",
      after: {
        email,
        role: dto.role,
        expiresAt: expiresAt.toISOString()
      }
    });

    return {
      inviteLink,
      expiresAt: expiresAt.toISOString()
    };
  }

  async acceptInvite(dto: AcceptOrgInviteDto): Promise<AcceptOrgInviteResponse> {
    const now = new Date();
    const tokenHash = this.hashToken(dto.token);
    const orgId = dto.orgId;

    const invite = await this.prisma.orgInviteToken.findFirst({
      where: {
        orgId,
        tokenHash,
        usedAt: null,
        expiresAt: {
          gt: now
        }
      }
    });

    if (!invite) {
      throw new BadRequestException("Invite is invalid or expired");
    }

    const normalizedEmail = invite.email.trim().toLowerCase();

    const result = await this.prisma.$transaction(async (tx) => {
      const updateInvite = await tx.orgInviteToken.updateMany({
        where: {
          id: invite.id,
          usedAt: null
        },
        data: {
          usedAt: now
        }
      });
      if (updateInvite.count === 0) {
        throw new ConflictException("Invite already used");
      }

      let user = await tx.user.findUnique({
        where: { email: normalizedEmail }
      });

      if (!user) {
        if (!dto.name || !dto.password) {
          throw new BadRequestException("Name and password are required for new users");
        }
        const passwordHash = await hash(dto.password, 10);
        user = await tx.user.create({
          data: {
            orgId,
            name: dto.name.trim(),
            email: normalizedEmail,
            role: invite.role,
            isActive: true,
            passwordHash
          }
        });
      }

      await tx.orgMember.upsert({
        where: {
          orgId_email: {
            orgId,
            email: normalizedEmail
          }
        },
        create: {
          orgId,
          userId: user.id,
          email: normalizedEmail,
          role: invite.role,
          status: "ACTIVE",
          joinedAt: now
        },
        update: {
          userId: user.id,
          role: invite.role,
          status: "ACTIVE",
          joinedAt: now
        }
      });

      return user;
    });

    await this.activityLogService.log({
      orgId,
      actorUserId: result.id,
      entityType: ActivityEntityType.USER,
      entityId: result.id,
      action: "ORG_INVITE_ACCEPTED",
      after: {
        email: normalizedEmail,
        orgId,
        role: invite.role
      }
    });

    const accessToken = await this.issueAccessToken({
      sub: result.id,
      orgId,
      activeOrgId: orgId,
      role: invite.role,
      email: result.email,
      name: result.name
    });

    return {
      success: true,
      accessToken,
      user: {
        id: result.id,
        email: result.email,
        role: invite.role,
        orgId
      }
    };
  }

  async updateMember(authUser: AuthUserContext, userId: string, dto: UpdateOrgMemberDto) {
    const activeOrgId = authUser.activeOrgId ?? authUser.orgId;
    const actorRole = authUser.role;

    const existing = await this.prisma.orgMember.findFirst({
      where: {
        orgId: activeOrgId,
        userId
      },
      include: {
        user: {
          select: {
            id: true,
            role: true
          }
        }
      }
    });
    if (!existing) {
      throw new NotFoundException("Member not found");
    }

    if (existing.userId === authUser.userId && dto.status === "REMOVED") {
      throw new ConflictException("Cannot remove self");
    }

    if (actorRole === Role.CEO && dto.role === Role.ADMIN) {
      throw new ForbiddenException("CEO cannot grant ADMIN role");
    }

    const updated = await this.prisma.orgMember.update({
      where: { id: existing.id },
      data: {
        role: dto.role,
        status: dto.status
      }
    });

    await this.activityLogService.log({
      orgId: activeOrgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.USER,
      entityId: existing.userId ?? existing.id,
      action: dto.status === "REMOVED" ? "ORG_MEMBER_REMOVED" : "ORG_MEMBER_UPDATED",
      before: {
        role: existing.role,
        status: existing.status
      },
      after: {
        role: updated.role,
        status: updated.status
      }
    });

    return updated;
  }

  private async enforceInviteRateLimit(orgId: string, invitedByUserId: string): Promise<void> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const count = await this.prisma.orgInviteToken.count({
      where: {
        orgId,
        invitedByUserId,
        createdAt: {
          gte: cutoff
        }
      }
    });
    if (count >= INVITE_DAILY_LIMIT) {
      throw new BadRequestException("Invite rate limit reached");
    }
  }

  private hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private async issueAccessToken(payload: AuthTokenPayload): Promise<string> {
    const expiresIn = (process.env.ACCESS_TOKEN_TTL ?? process.env.JWT_EXPIRES_IN ?? "15m") as StringValue;
    return this.jwtService.signAsync(payload, {
      secret: process.env.JWT_SECRET,
      algorithm: "HS256",
      expiresIn
    });
  }
}
