import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuthUserContext } from "../auth/auth.types";
import { BillingService } from "../billing/billing.service";
import { getActiveOrgId } from "../common/auth-org";
import { toPaginatedResponse } from "../common/dto/paginated-response.dto";
import { PrismaService } from "../prisma/prisma.service";
import { ListSecurityEventsDto } from "./dto/list-security-events.dto";

interface SecurityEventInput {
  orgId: string;
  type: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  description: string;
  entityType?: string;
  entityId?: string;
  userId?: string;
  meta?: Record<string, unknown>;
}

interface FailedLoginBucket {
  timestamps: number[];
  lastEventAt: number | null;
}

@Injectable()
export class ShieldService {
  private readonly failedLoginBuckets = new Map<string, FailedLoginBucket>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly billingService: BillingService
  ) {}

  async createEvent(input: SecurityEventInput) {
    return this.prisma.securityEvent.create({
      data: {
        orgId: input.orgId,
        type: input.type,
        severity: input.severity,
        description: input.description,
        entityType: input.entityType,
        entityId: input.entityId,
        userId: input.userId,
        meta: input.meta as Prisma.InputJsonValue | undefined
      }
    });
  }

  async listEvents(authUser: AuthUserContext, query: ListSecurityEventsDto) {
    const activeOrgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(activeOrgId, "shieldEnabled");
    const skip = (query.page - 1) * query.pageSize;
    const where = {
      orgId: activeOrgId,
      ...(query.severity ? { severity: query.severity.toUpperCase() } : {}),
      ...(query.resolved === undefined
        ? {}
        : query.resolved === "true"
          ? { resolvedAt: { not: null } }
          : { resolvedAt: null })
    };

    const items = await this.prisma.securityEvent.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip,
      take: query.pageSize
    });
    const total = await this.prisma.securityEvent.count({ where });

    return toPaginatedResponse(items, query.page, query.pageSize, total);
  }

  async resolveEvent(authUser: AuthUserContext, id: string) {
    const activeOrgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(activeOrgId, "shieldEnabled");
    const existing = await this.prisma.securityEvent.findFirst({
      where: {
        id,
        orgId: activeOrgId
      }
    });
    if (!existing) {
      throw new NotFoundException("Security event not found");
    }

    if (existing.resolvedAt) {
      return existing;
    }

    return this.prisma.securityEvent.update({
      where: { id: existing.id },
      data: {
        resolvedAt: new Date()
      }
    });
  }

  async detectBulkUserDeactivation(orgId: string, actorUserId: string): Promise<void> {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const deactivationCount = await this.prisma.activityLog.count({
      where: {
        orgId,
        actorUserId,
        entityType: "USER",
        action: "USER_DEACTIVATE",
        createdAt: { gte: tenMinutesAgo }
      }
    });
    const existingSpike = await this.prisma.securityEvent.findFirst({
      where: {
        orgId,
        type: "BULK_USER_DEACTIVATION",
        userId: actorUserId,
        createdAt: { gte: tenMinutesAgo }
      },
      select: { id: true }
    });

    if (deactivationCount > 3 && !existingSpike) {
      await this.createEvent({
        orgId,
        type: "BULK_USER_DEACTIVATION",
        severity: "HIGH",
        description: "More than 3 users were deactivated by the same admin in 10 minutes.",
        userId: actorUserId,
        meta: { deactivationCount, windowMinutes: 10 }
      });
    }
  }

  async registerFailedLoginAttempt(input: {
    orgId: string;
    userId: string;
    email: string;
  }): Promise<void> {
    const nowMs = Date.now();
    const key = `${input.orgId}:${input.email.toLowerCase()}`;
    const bucket = this.failedLoginBuckets.get(key) ?? {
      timestamps: [],
      lastEventAt: null
    };
    const windowStart = nowMs - 10 * 60 * 1000;
    bucket.timestamps = bucket.timestamps.filter((ts) => ts >= windowStart);
    bucket.timestamps.push(nowMs);

    if (bucket.timestamps.length >= 5) {
      if (!bucket.lastEventAt || bucket.lastEventAt < windowStart) {
        await this.createEvent({
          orgId: input.orgId,
          type: "FAILED_LOGIN_SPIKE",
          severity: "MEDIUM",
          description: "More than 5 failed login attempts detected within 10 minutes.",
          userId: input.userId,
          meta: { email: input.email, failedAttempts: bucket.timestamps.length, windowMinutes: 10 }
        });
        bucket.lastEventAt = nowMs;
      }
    }

    this.failedLoginBuckets.set(key, bucket);
  }

  clearFailedLoginAttempts(orgId: string, email: string): void {
    const key = `${orgId}:${email.toLowerCase()}`;
    this.failedLoginBuckets.delete(key);
  }

}
