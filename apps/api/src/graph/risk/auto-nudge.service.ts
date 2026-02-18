import { Injectable, Logger } from "@nestjs/common";
import {
  ActivityEntityType,
  NudgeSeverity,
  NudgeStatus,
  NudgeType,
  Prisma,
  Role
} from "@prisma/client";
import { ActivityLogService } from "../../activity-log/activity-log.service";
import { PrismaService } from "../../prisma/prisma.service";
import { RiskDriver } from "./risk-engine.service";

const MAX_AUTO_NUDGES_PER_DAY = 20;
const RISK_AUTO_NUDGE_TYPES: NudgeType[] = [
  NudgeType.RISK_INVOICE_OVERDUE,
  NudgeType.RISK_INVOICE_HIGH_AMOUNT_UNPAID,
  NudgeType.RISK_WORK_OVERDUE,
  NudgeType.RISK_WORK_BLOCKED,
  NudgeType.RISK_INCIDENT_OPEN,
  NudgeType.RISK_DEAL_STALLED
];

type MappedRiskNudge = {
  nudgeType: NudgeType;
  entityType: ActivityEntityType;
  entityId: string;
  title: string;
  message: string;
  deeplink?: { url: string; label: string };
};

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function severityFromRiskScore(riskScore: number): NudgeSeverity {
  if (riskScore >= 85) {
    return NudgeSeverity.CRITICAL;
  }
  if (riskScore >= 70) {
    return NudgeSeverity.HIGH;
  }
  return NudgeSeverity.MEDIUM;
}

function buildEvidenceSummary(driver: RiskDriver): string {
  const evidence: string[] = [];
  if (driver.evidence.status) {
    evidence.push(`status=${driver.evidence.status}`);
  }
  if (driver.evidence.dueAt) {
    evidence.push(`due=${driver.evidence.dueAt.slice(0, 10)}`);
  }
  if (typeof driver.evidence.amountCents === "number") {
    evidence.push(`amount=${driver.evidence.amountCents}`);
  }
  return evidence.length ? evidence.join(", ") : "no additional evidence";
}

@Injectable()
export class AutoNudgeService {
  private readonly logger = new Logger(AutoNudgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLogService: ActivityLogService
  ) {}

  async generateRiskNudges(orgId: string, topDrivers: RiskDriver[], asOfDate: Date) {
    const dateKey = toDateKey(asOfDate);
    const dayStart = new Date(`${dateKey}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    const existingToday = await this.prisma.nudge.count({
      where: {
        orgId,
        createdAt: {
          gte: dayStart,
          lt: dayEnd
        },
        type: {
          in: RISK_AUTO_NUDGE_TYPES
        }
      }
    });

    if (existingToday >= MAX_AUTO_NUDGES_PER_DAY) {
      this.logger.warn(`Risk auto-nudge cap reached org=${orgId} date=${dateKey}`);
      return { created: 0, skipped: topDrivers.length, capped: true };
    }

    let created = 0;
    let skipped = 0;
    let remaining = MAX_AUTO_NUDGES_PER_DAY - existingToday;

    for (const driver of topDrivers) {
      if (remaining <= 0) {
        break;
      }

      const mapped = this.mapDriver(driver);
      if (!mapped) {
        skipped += 1;
        continue;
      }

      const uniqueKey = `${orgId}:${mapped.nudgeType}:${mapped.entityType}:${mapped.entityId}:${dateKey}`;
      const existingByKey = await this.prisma.nudge.findUnique({
        where: { uniqueKey },
        select: { id: true }
      });
      if (existingByKey) {
        skipped += 1;
        continue;
      }

      const existingOpenForEntity = await this.prisma.nudge.findFirst({
        where: {
          orgId,
          entityType: mapped.entityType,
          entityId: mapped.entityId,
          status: NudgeStatus.OPEN
        },
        select: { id: true }
      });
      if (existingOpenForEntity) {
        skipped += 1;
        continue;
      }

      const assignee = await this.resolveAssignee(orgId, mapped.nudgeType);
      if (!assignee) {
        skipped += 1;
        continue;
      }

      const createdByUserId = await this.resolveSystemActor(orgId, assignee.id);
      const priorityScore = Math.max(0, Math.min(100, Math.round(driver.riskScore)));

      const nudge = await this.prisma.nudge.create({
        data: {
          orgId,
          createdByUserId,
          targetUserId: assignee.id,
          type: mapped.nudgeType,
          entityType: mapped.entityType,
          entityId: mapped.entityId,
          message: `${mapped.title}: ${mapped.message}`,
          severity: severityFromRiskScore(driver.riskScore),
          priorityScore,
          uniqueKey,
          meta: {
            source: "risk_engine",
            nudgeType: mapped.nudgeType,
            nodeId: driver.nodeId,
            entityId: driver.entityId,
            reasonCodes: driver.reasonCodes,
            evidence: driver.evidence,
            deeplink: mapped.deeplink ?? null,
            title: mapped.title,
            dateKey
          } as Prisma.InputJsonValue
        }
      });

      await this.activityLogService.log({
        orgId,
        actorUserId: createdByUserId,
        entityType: ActivityEntityType.ALERT,
        entityId: nudge.id,
        action: "NUDGE_AUTO_CREATED",
        after: {
          nudgeId: nudge.id,
          nudgeType: mapped.nudgeType,
          nodeId: driver.nodeId,
          entityId: driver.entityId
        }
      });

      created += 1;
      remaining -= 1;
    }

    return {
      created,
      skipped,
      capped: remaining <= 0
    };
  }

  async generateFromLatestSnapshot(orgId: string) {
    const latest = await this.prisma.orgRiskSnapshot.findFirst({
      where: { orgId },
      orderBy: [{ asOfDate: "desc" }, { createdAt: "desc" }],
      select: { asOfDate: true, drivers: true }
    });

    if (!latest || !Array.isArray(latest.drivers)) {
      return { created: 0, skipped: 0, capped: false };
    }

    return this.generateRiskNudges(orgId, latest.drivers as unknown as RiskDriver[], latest.asOfDate);
  }

  async listRecentRiskNudges(orgId: string) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const items = await this.prisma.nudge.findMany({
      where: {
        orgId,
        type: {
          in: RISK_AUTO_NUDGE_TYPES
        },
        createdAt: {
          gte: since
        }
      },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      include: {
        targetUser: {
          select: {
            id: true,
            name: true,
            email: true
          }
        }
      }
    });

    return {
      items: items.map((item) => {
        const meta = (item.meta as Record<string, unknown> | null) ?? null;
        return {
          id: item.id,
          type: item.type,
          entityType: item.entityType,
          entityId: item.entityId,
          message: item.message,
          severity: item.severity,
          status: item.status,
          targetUser: item.targetUser,
          createdAt: item.createdAt,
          resolvedAt: item.resolvedAt,
          deeplink:
            meta && typeof meta.deeplink === "object" && meta.deeplink !== null
              ? (meta.deeplink as { url?: string; label?: string })
              : null,
          meta
        };
      })
    };
  }

  private mapDriver(driver: RiskDriver): MappedRiskNudge | null {
    const reasonSet = new Set(driver.reasonCodes);

    if (reasonSet.has("INVOICE_OVERDUE") && driver.type === "INVOICE") {
      return {
        nudgeType: NudgeType.RISK_INVOICE_OVERDUE,
        entityType: ActivityEntityType.INVOICE,
        entityId: driver.entityId,
        title: "Overdue invoice needs follow-up",
        message: buildEvidenceSummary(driver),
        deeplink: driver.deeplink
      };
    }

    if (reasonSet.has("INVOICE_HIGH_AMOUNT") && driver.type === "INVOICE") {
      return {
        nudgeType: NudgeType.RISK_INVOICE_HIGH_AMOUNT_UNPAID,
        entityType: ActivityEntityType.INVOICE,
        entityId: driver.entityId,
        title: "High-value unpaid invoice requires action",
        message: buildEvidenceSummary(driver),
        deeplink: driver.deeplink
      };
    }

    if (reasonSet.has("WORK_OVERDUE") && driver.type === "WORK_ITEM") {
      return {
        nudgeType: NudgeType.RISK_WORK_OVERDUE,
        entityType: ActivityEntityType.WORK_ITEM,
        entityId: driver.entityId,
        title: "Overdue work item requires attention",
        message: buildEvidenceSummary(driver),
        deeplink: driver.deeplink
      };
    }

    if (reasonSet.has("WORK_BLOCKED") && driver.type === "WORK_ITEM") {
      return {
        nudgeType: NudgeType.RISK_WORK_BLOCKED,
        entityType: ActivityEntityType.WORK_ITEM,
        entityId: driver.entityId,
        title: "Blocked work item needs unblock",
        message: buildEvidenceSummary(driver),
        deeplink: driver.deeplink
      };
    }

    if (reasonSet.has("INCIDENT_OPEN") && driver.type === "INCIDENT") {
      return {
        nudgeType: NudgeType.RISK_INCIDENT_OPEN,
        entityType: ActivityEntityType.ALERT,
        entityId: driver.entityId,
        title: "Open incident needs escalation",
        message: buildEvidenceSummary(driver),
        deeplink: driver.deeplink
      };
    }

    if (driver.type === "DEAL" && reasonSet.has("PROPAGATED_FROM_INVOICE")) {
      return {
        nudgeType: NudgeType.RISK_DEAL_STALLED,
        entityType: ActivityEntityType.DEAL,
        entityId: driver.entityId,
        title: "Deal risk is increasing",
        message: buildEvidenceSummary(driver),
        deeplink: driver.deeplink
      };
    }

    return null;
  }

  private async resolveAssignee(orgId: string, nudgeType: NudgeType) {
    const roleOrder = this.assigneeRoleOrder(nudgeType);
    for (const role of roleOrder) {
      const user = await this.prisma.user.findFirst({
        where: {
          orgId,
          role,
          isActive: true
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true }
      });
      if (user) {
        return user;
      }
    }

    return null;
  }

  private assigneeRoleOrder(nudgeType: NudgeType): Role[] {
    if (
      nudgeType === NudgeType.RISK_INVOICE_OVERDUE ||
      nudgeType === NudgeType.RISK_INVOICE_HIGH_AMOUNT_UNPAID
    ) {
      return [Role.FINANCE, Role.ADMIN];
    }
    if (nudgeType === NudgeType.RISK_WORK_OVERDUE || nudgeType === NudgeType.RISK_WORK_BLOCKED) {
      return [Role.OPS, Role.ADMIN];
    }
    if (nudgeType === NudgeType.RISK_DEAL_STALLED) {
      return [Role.SALES, Role.CEO];
    }
    if (nudgeType === NudgeType.RISK_INCIDENT_OPEN) {
      return [Role.OPS, Role.CEO];
    }
    return [Role.ADMIN];
  }

  private async resolveSystemActor(orgId: string, fallbackUserId: string): Promise<string> {
    const actor = await this.prisma.user.findFirst({
      where: {
        orgId,
        isActive: true,
        role: {
          in: [Role.ADMIN, Role.CEO]
        }
      },
      orderBy: [{ role: "desc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true }
    });

    return actor?.id ?? fallbackUserId;
  }
}
