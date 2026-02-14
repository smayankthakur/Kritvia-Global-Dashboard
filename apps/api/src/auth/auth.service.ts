import { ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { StringValue } from "ms";
import { ActivityEntityType } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { ActivityLogService } from "../activity-log/activity-log.service";
import { PrismaService } from "../prisma/prisma.service";
import { ShieldService } from "../shield/shield.service";
import { LoginDto } from "./dto/login.dto";
import { AuthTokenPayload, AuthUserContext } from "./auth.types";

const { compare } = require("bcryptjs") as {
  compare: (plainText: string, hash: string) => Promise<boolean>;
};

export interface AuthTokensResponse {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly activityLogService: ActivityLogService,
    private readonly shieldService: ShieldService
  ) {}

  async login(dto: LoginDto): Promise<AuthTokensResponse> {
    const normalizedEmail = dto.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail }
    });

    if (!user) {
      throw new UnauthorizedException("Invalid credentials");
    }
    if (!user.isActive) {
      throw new ForbiddenException("Account deactivated");
    }

    const isPasswordValid = await compare(dto.password, user.passwordHash);
    if (!isPasswordValid) {
      await this.shieldService.registerFailedLoginAttempt({
        orgId: user.orgId,
        userId: user.id,
        email: normalizedEmail
      });
      throw new UnauthorizedException("Invalid credentials");
    }
    this.shieldService.clearFailedLoginAttempts(user.orgId, normalizedEmail);

    const accessToken = await this.issueAccessToken({
      sub: user.id,
      orgId: user.orgId,
      role: user.role,
      email: user.email,
      name: user.name
    });

    const refreshToken = this.generateRefreshToken();
    await this.createRefreshTokenRecord({
      orgId: user.orgId,
      userId: user.id,
      refreshToken
    });

    await this.activityLogService.log({
      orgId: user.orgId,
      actorUserId: user.id,
      entityType: ActivityEntityType.AUTH,
      entityId: user.id,
      action: "LOGIN_SUCCESS",
      after: { email: user.email }
    });

    return { accessToken, refreshToken };
  }

  async refresh(rawRefreshToken: string): Promise<AuthTokensResponse> {
    const tokenHash = this.hashRefreshToken(rawRefreshToken);
    const now = new Date();
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: {
        user: true
      }
    });

    if (!existing || existing.revokedAt || existing.expiresAt <= now) {
      throw new UnauthorizedException("Invalid refresh token");
    }

    if (!existing.user.isActive || existing.user.orgId !== existing.orgId) {
      throw new UnauthorizedException("Invalid refresh token");
    }

    const newRefreshToken = this.generateRefreshToken();
    const newTokenHash = this.hashRefreshToken(newRefreshToken);
    const newTokenExpiresAt = this.getRefreshTokenExpiry();

    const rotated = await this.prisma.$transaction(async (transaction) => {
      const nextToken = await transaction.refreshToken.create({
        data: {
          orgId: existing.orgId,
          userId: existing.userId,
          tokenHash: newTokenHash,
          expiresAt: newTokenExpiresAt
        }
      });

      await transaction.refreshToken.update({
        where: { id: existing.id },
        data: {
          revokedAt: now,
          replacedByTokenId: nextToken.id
        }
      });

      return nextToken;
    });

    const accessToken = await this.issueAccessToken({
      sub: existing.user.id,
      orgId: existing.user.orgId,
      role: existing.user.role,
      email: existing.user.email,
      name: existing.user.name
    });

    await this.activityLogService.log({
      orgId: existing.orgId,
      actorUserId: existing.userId,
      entityType: ActivityEntityType.AUTH,
      entityId: existing.userId,
      action: "TOKEN_REFRESH",
      before: { refreshTokenId: existing.id },
      after: { refreshTokenId: rotated.id }
    });

    return {
      accessToken,
      refreshToken: newRefreshToken
    };
  }

  async logout(rawRefreshToken?: string): Promise<void> {
    if (!rawRefreshToken) {
      return;
    }

    const tokenHash = this.hashRefreshToken(rawRefreshToken);
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash }
    });

    if (!existing || existing.revokedAt) {
      return;
    }

    await this.prisma.refreshToken.update({
      where: { id: existing.id },
      data: {
        revokedAt: new Date()
      }
    });

    await this.activityLogService.log({
      orgId: existing.orgId,
      actorUserId: existing.userId,
      entityType: ActivityEntityType.AUTH,
      entityId: existing.userId,
      action: "LOGOUT",
      before: { refreshTokenId: existing.id }
    });
  }

  async getMe(authUser: AuthUserContext): Promise<{
    id: string;
    name: string;
    email: string;
    role: AuthUserContext["role"];
    orgId: string;
  }> {
    const user = await this.prisma.user.findFirst({
      where: {
        id: authUser.userId,
        orgId: authUser.orgId,
        isActive: true
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        orgId: true
      }
    });

    if (!user) {
      throw new UnauthorizedException("User not found");
    }

    return user;
  }

  private async issueAccessToken(payload: AuthTokenPayload): Promise<string> {
    const expiresIn = (process.env.ACCESS_TOKEN_TTL ?? process.env.JWT_EXPIRES_IN ?? "15m") as StringValue;
    return this.jwtService.signAsync(payload, {
      secret: process.env.JWT_SECRET,
      algorithm: "HS256",
      expiresIn
    });
  }

  private generateRefreshToken(): string {
    return randomBytes(48).toString("base64url");
  }

  private hashRefreshToken(refreshToken: string): string {
    return createHash("sha256").update(refreshToken).digest("hex");
  }

  private async createRefreshTokenRecord(input: {
    orgId: string;
    userId: string;
    refreshToken: string;
  }): Promise<void> {
    await this.prisma.refreshToken.create({
      data: {
        orgId: input.orgId,
        userId: input.userId,
        tokenHash: this.hashRefreshToken(input.refreshToken),
        expiresAt: this.getRefreshTokenExpiry()
      }
    });
  }

  private getRefreshTokenExpiry(): Date {
    const ttlFromDuration = this.parseDurationMs(process.env.REFRESH_TOKEN_TTL);
    const ttlDays = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 7);
    const ttlMs =
      ttlFromDuration ?? (Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays * 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000);
    const expires = new Date();
    expires.setTime(expires.getTime() + ttlMs);
    return expires;
  }

  private parseDurationMs(raw: string | undefined): number | null {
    if (!raw) {
      return null;
    }
    const value = raw.trim().toLowerCase();
    const match = value.match(/^(\d+)(ms|s|m|h|d)$/);
    if (!match) {
      return null;
    }
    const amount = Number(match[1]);
    const unit = match[2];
    const unitMs: Record<string, number> = {
      ms: 1,
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000
    };
    return amount * unitMs[unit];
  }
}
