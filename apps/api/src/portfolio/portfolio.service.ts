import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  ActivityEntityType,
  InvoiceStatus,
  NudgeStatus,
  Prisma,
  WorkItemStatus
} from "@prisma/client";
import { ActivityLogService } from "../activity-log/activity-log.service";
import { AuthUserContext } from "../auth/auth.types";
import { BillingService } from "../billing/billing.service";
import { getActiveOrgId } from "../common/auth-org";
import { toPaginatedResponse } from "../common/dto/paginated-response.dto";
import { PrismaService } from "../prisma/prisma.service";
import { AttachPortfolioOrgDto } from "./dto/attach-portfolio-org.dto";
import { CreatePortfolioDto } from "./dto/create-portfolio.dto";
import { ListPortfolioDto } from "./dto/list-portfolio.dto";

type PortfolioRole = "OWNER" | "MANAGER" | "VIEWER";

@Injectable()
export class PortfolioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLogService: ActivityLogService,
    private readonly billingService: BillingService
  ) {}

  async create(authUser: AuthUserContext, dto: CreatePortfolioDto) {
    const activeOrgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(activeOrgId, "portfolioEnabled");

    const created = await this.prisma.orgGroup.create({
      data: {
        name: dto.name.trim(),
        ownerUserId: authUser.userId,
        members: {
          create: {
            userId: authUser.userId,
            role: "OWNER"
          }
        }
      }
    });

    await this.activityLogService.log({
      orgId: authUser.activeOrgId ?? authUser.orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.PORTFOLIO,
      entityId: created.id,
      action: "PORTFOLIO_CREATE",
      after: created
    });

    return created;
  }

  async list(authUser: AuthUserContext, query: ListPortfolioDto) {
    const activeOrgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(activeOrgId, "portfolioEnabled");

    const actorIdentityUserIds = await this.getActorIdentityUserIds(authUser);
    const sortBy = query.sortBy ?? "createdAt";
    const skip = (query.page - 1) * query.pageSize;
    const where = {
      userId: {
        in: actorIdentityUserIds
      }
    };

    const [members, total] = await this.prisma.$transaction([
      this.prisma.orgGroupMember.findMany({
        where,
        orderBy: [
          sortBy === "role"
            ? { role: query.sortDir }
            : { group: { [sortBy]: query.sortDir } },
          { id: "asc" }
        ],
        skip,
        take: query.pageSize,
        select: {
          role: true,
          group: {
            select: {
              id: true,
              name: true,
              _count: {
                select: {
                  orgs: true
                }
              }
            }
          }
        }
      }),
      this.prisma.orgGroupMember.count({ where })
    ]);

    const items = members.map((member) => ({
      id: member.group.id,
      name: member.group.name,
      role: member.role,
      orgCount: member.group._count.orgs
    }));

    return toPaginatedResponse(items, query.page, query.pageSize, total);
  }

  async attachOrg(authUser: AuthUserContext, groupId: string, dto: AttachPortfolioOrgDto) {
    const activeOrgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(activeOrgId, "portfolioEnabled");

    const membership = await this.requireGroupMembership(authUser, groupId);
    if (membership.role !== "OWNER" && membership.role !== "MANAGER") {
      throw new ForbiddenException("Only OWNER or MANAGER can attach organizations");
    }

    const actorIdentity = await this.getActorIdentityUsers(authUser);
    const hasOrgAccess = actorIdentity.some(
      (identityUser) => identityUser.orgId === dto.orgId && identityUser.isActive
    );
    if (!hasOrgAccess) {
      throw new ForbiddenException("You are not an active member of this organization");
    }

    const org = await this.prisma.org.findUnique({
      where: { id: dto.orgId },
      select: { id: true, name: true }
    });
    if (!org) {
      throw new NotFoundException("Organization not found");
    }

    const attached = await this.prisma.orgGroupOrg.upsert({
      where: {
        groupId_orgId: {
          groupId,
          orgId: dto.orgId
        }
      },
      create: {
        groupId,
        orgId: dto.orgId
      },
      update: {}
    });

    await this.activityLogService.log({
      orgId: dto.orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.PORTFOLIO,
      entityId: groupId,
      action: "PORTFOLIO_ATTACH_ORG",
      after: {
        groupId,
        orgId: attached.orgId
      }
    });

    return {
      id: attached.id,
      groupId: attached.groupId,
      orgId: attached.orgId
    };
  }

  async detachOrg(authUser: AuthUserContext, groupId: string, orgId: string) {
    const activeOrgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(activeOrgId, "portfolioEnabled");

    const membership = await this.requireGroupMembership(authUser, groupId);
    if (membership.role !== "OWNER") {
      throw new ForbiddenException("Only OWNER can detach organizations");
    }

    const existing = await this.prisma.orgGroupOrg.findUnique({
      where: {
        groupId_orgId: {
          groupId,
          orgId
        }
      }
    });
    if (!existing) {
      throw new NotFoundException("Portfolio organization link not found");
    }

    await this.prisma.orgGroupOrg.delete({
      where: { id: existing.id }
    });

    await this.activityLogService.log({
      orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.PORTFOLIO,
      entityId: groupId,
      action: "PORTFOLIO_DETACH_ORG",
      before: {
        groupId,
        orgId
      }
    });

    return {
      success: true
    };
  }

  async getSummary(authUser: AuthUserContext, groupId: string) {
    const activeOrgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(activeOrgId, "portfolioEnabled");

    const membership = await this.requireGroupMembership(authUser, groupId);

    const group = await this.prisma.orgGroup.findUnique({
      where: { id: groupId },
      select: {
        id: true,
        name: true
      }
    });
    if (!group) {
      throw new NotFoundException("Portfolio not found");
    }

    const groupOrgs = await this.prisma.orgGroupOrg.findMany({
      where: { groupId },
      select: { orgId: true }
    });
    const orgIds = groupOrgs.map((item) => item.orgId);
    if (orgIds.length === 0) {
      return {
        group: {
          id: group.id,
          name: group.name,
          role: membership.role
        },
        rows: []
      };
    }

    const today = new Date();
    const [orgs, latestSnapshotRows, openNudges, receivables, overdueWork, criticalShield] =
      await this.prisma.$transaction([
        this.prisma.org.findMany({
          where: { id: { in: orgIds } },
          select: { id: true, name: true }
        }),
        this.prisma.$queryRaw<Array<{ org_id: string; score: number }>>(Prisma.sql`
          SELECT DISTINCT ON (org_id) org_id, score
          FROM org_health_snapshots
          WHERE org_id IN (${Prisma.join(orgIds)})
          ORDER BY org_id, computed_at DESC
        `),
        this.prisma.$queryRaw<Array<{ org_id: string; count: number }>>(Prisma.sql`
          SELECT org_id, COUNT(*)::int AS count
          FROM nudges
          WHERE org_id IN (${Prisma.join(orgIds)})
            AND status = ${NudgeStatus.OPEN}
          GROUP BY org_id
        `),
        this.prisma.$queryRaw<Array<{ org_id: string; amount: Prisma.Decimal | number | string }>>(
          Prisma.sql`
            SELECT org_id, COALESCE(SUM(amount), 0) AS amount
            FROM invoices
            WHERE org_id IN (${Prisma.join(orgIds)})
              AND status <> ${InvoiceStatus.PAID}
            GROUP BY org_id
          `
        ),
        this.prisma.$queryRaw<Array<{ org_id: string; count: number }>>(Prisma.sql`
          SELECT org_id, COUNT(*)::int AS count
          FROM work_items
          WHERE org_id IN (${Prisma.join(orgIds)})
            AND status <> ${WorkItemStatus.DONE}
            AND due_date < ${today}
          GROUP BY org_id
        `),
        this.prisma.$queryRaw<Array<{ org_id: string; count: number }>>(Prisma.sql`
          SELECT org_id, COUNT(*)::int AS count
          FROM security_events
          WHERE org_id IN (${Prisma.join(orgIds)})
            AND severity = 'CRITICAL'
            AND resolved_at IS NULL
          GROUP BY org_id
        `)
      ]);

    const orgById = new Map(orgs.map((org) => [org.id, org]));
    const snapshotByOrgId = new Map<string, number>();
    for (const snapshot of latestSnapshotRows) {
      snapshotByOrgId.set(snapshot.org_id, snapshot.score);
    }
    const openNudgesByOrg = new Map<string, number>();
    for (const row of openNudges) {
      openNudgesByOrg.set(row.org_id, Number(row.count));
    }

    const receivablesByOrg = new Map<string, number>();
    for (const row of receivables) {
      receivablesByOrg.set(row.org_id, Math.round(Number(row.amount)));
    }

    const overdueWorkByOrg = new Map<string, number>();
    for (const row of overdueWork) {
      overdueWorkByOrg.set(row.org_id, Number(row.count));
    }

    const criticalByOrg = new Map<string, number>();
    for (const row of criticalShield) {
      criticalByOrg.set(row.org_id, Number(row.count));
    }

    const rows = orgIds
      .map((orgId) => {
        const org = orgById.get(orgId);
        if (!org) {
          return null;
        }
        return {
          org: {
            id: org.id,
            name: org.name
          },
          kpis: {
            healthScore: snapshotByOrgId.get(orgId) ?? null,
            openNudgesCount: openNudgesByOrg.get(orgId) ?? 0,
            outstandingReceivables: receivablesByOrg.get(orgId) ?? 0,
            overdueWorkCount: overdueWorkByOrg.get(orgId) ?? 0,
            criticalShieldCount: criticalByOrg.get(orgId) ?? 0
          },
          deepLinks: {
            switchOrg: `/ceo/dashboard?orgId=${orgId}`,
            viewOpsOverdue: `/ops/hygiene?filter=overdue&orgId=${orgId}`,
            viewInvoicesOverdue: `/finance/invoices?status=OVERDUE&orgId=${orgId}`,
            viewShield: `/shield?severity=CRITICAL&orgId=${orgId}`
          }
        };
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row));

    return {
      group: {
        id: group.id,
        name: group.name,
        role: membership.role
      },
      rows
    };
  }

  private async requireGroupMembership(authUser: AuthUserContext, groupId: string) {
    const actorIdentityUserIds = await this.getActorIdentityUserIds(authUser);
    const membership = await this.prisma.orgGroupMember.findFirst({
      where: {
        groupId,
        userId: {
          in: actorIdentityUserIds
        }
      },
      select: {
        role: true,
        groupId: true,
        userId: true
      }
    });
    if (!membership) {
      throw new ForbiddenException("Portfolio access denied");
    }
    return membership as { role: PortfolioRole; groupId: string; userId: string };
  }

  private async getActorIdentityUserIds(authUser: AuthUserContext): Promise<string[]> {
    const users = await this.getActorIdentityUsers(authUser);
    return users.map((user) => user.id);
  }

  private async getActorIdentityUsers(authUser: AuthUserContext) {
    return this.prisma.user.findMany({
      where: {
        email: authUser.email
      },
      select: {
        id: true,
        orgId: true,
        isActive: true
      }
    });
  }
}
