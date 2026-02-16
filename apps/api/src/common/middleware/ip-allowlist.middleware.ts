import { HttpException, HttpStatus, Injectable, NestMiddleware } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { createHash } from "node:crypto";
import { AuthTokenPayload } from "../../auth/auth.types";
import { PrismaService } from "../../prisma/prisma.service";
import {
  extractClientIp,
  ipMatchesAllowlist
} from "../ip-allowlist.util";

@Injectable()
export class IpAllowlistMiddleware implements NestMiddleware {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService
  ) {}

  async use(
    req: {
      headers: Record<string, string | string[] | undefined>;
      cookies?: Record<string, string | undefined>;
      ip?: string;
      socket?: { remoteAddress?: string };
    },
    _res: unknown,
    next: () => void
  ): Promise<void> {
    const orgId = await this.resolveOrgId(req);
    if (!orgId) {
      next();
      return;
    }

    const policy = await this.prisma.policy.upsert({
      where: { orgId },
      update: {},
      create: {
        orgId,
        lockInvoiceOnSent: true,
        overdueAfterDays: 0,
        defaultWorkDueDays: 3,
        staleDealAfterDays: 7,
        leadStaleAfterHours: 72,
        requireDealOwner: true,
        requireWorkOwner: true,
        requireWorkDueDate: true,
        autoLockInvoiceAfterDays: 2,
        preventInvoiceUnlockAfterPartialPayment: true,
        autopilotEnabled: false,
        autopilotCreateWorkOnDealStageChange: true,
        autopilotNudgeOnOverdue: true,
        autopilotAutoStaleDeals: true,
        auditRetentionDays: 180,
        securityEventRetentionDays: 180,
        ipRestrictionEnabled: false,
        ipAllowlist: []
      }
    });

    if (!policy.ipRestrictionEnabled) {
      next();
      return;
    }

    const allowlist = Array.isArray(policy.ipAllowlist)
      ? policy.ipAllowlist.filter((entry): entry is string => typeof entry === "string")
      : [];
    const requestIp = extractClientIp(req);
    if (!requestIp || !ipMatchesAllowlist(requestIp, allowlist)) {
      throw new HttpException(
        {
          code: "IP_NOT_ALLOWED",
          message: "IP address is not allowed for this organization."
        },
        HttpStatus.FORBIDDEN
      );
    }

    next();
  }

  private async resolveOrgId(req: {
    headers: Record<string, string | string[] | undefined>;
    cookies?: Record<string, string | undefined>;
  }): Promise<string | null> {
    const authHeaderRaw = req.headers.authorization;
    const authHeader = Array.isArray(authHeaderRaw) ? authHeaderRaw[0] : authHeaderRaw;
    const bearerToken =
      authHeader && authHeader.startsWith("Bearer ")
        ? authHeader.slice("Bearer ".length).trim()
        : undefined;
    const cookieToken = req.cookies?.kritviya_access_token;
    const token = bearerToken ?? cookieToken;

    if (!token) {
      return null;
    }

    if (token.startsWith("ktv_live_")) {
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const apiToken = await this.prisma.apiToken.findFirst({
        where: {
          tokenHash,
          revokedAt: null
        },
        select: { orgId: true }
      });
      return apiToken?.orgId ?? null;
    }

    try {
      const payload = this.jwtService.verify<AuthTokenPayload>(token, {
        secret: process.env.JWT_SECRET
      });
      return payload.activeOrgId ?? payload.orgId;
    } catch {
      return null;
    }
  }
}
