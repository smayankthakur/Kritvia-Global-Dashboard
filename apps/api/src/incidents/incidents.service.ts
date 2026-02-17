import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { ActivityEntityType, Prisma } from "@prisma/client";
import { ActivityLogService } from "../activity-log/activity-log.service";
import { AuthUserContext } from "../auth/auth.types";
import { getActiveOrgId } from "../common/auth-org";
import { toPaginatedResponse } from "../common/dto/paginated-response.dto";
import { OnCallResolver } from "../oncall/oncall.resolver";
import { PrismaService } from "../prisma/prisma.service";
import { IncidentMetricsQueryDto } from "./dto/incident-metrics-query.dto";
import { IncidentNoteDto } from "./dto/incident-note.dto";
import { ListIncidentsQueryDto } from "./dto/list-incidents-query.dto";
import { PublicIncidentUpdateDto } from "./dto/public-incident-update.dto";
import { PublishIncidentDto } from "./dto/publish-incident.dto";
import { UpdateIncidentSeverityDto } from "./dto/update-incident-severity.dto";
import { UpsertIncidentPostmortemDto } from "./dto/upsert-incident-postmortem.dto";

const INCIDENT_STATUSES = ["OPEN", "ACKNOWLEDGED", "RESOLVED", "POSTMORTEM"] as const;
const INCIDENT_SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;

@Injectable()
export class IncidentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly onCallResolver: OnCallResolver,
    private readonly activityLogService: ActivityLogService
  ) {}

  async listIncidents(authUser: AuthUserContext, query: ListIncidentsQueryDto) {
    const orgId = getActiveOrgId({ user: authUser });
    const skip = (query.page - 1) * query.pageSize;

    const where: Prisma.IncidentWhereInput = {
      orgId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.severity ? { severity: query.severity } : {})
    };

    const [items, totalCount] = await this.prisma.$transaction([
      this.prisma.incident.findMany({
        where,
        include: {
          owner: {
            select: {
              id: true,
              name: true,
              email: true,
              role: true
            }
          }
        },
        orderBy: [{ createdAt: "desc" }],
        skip,
        take: query.pageSize
      }),
      this.prisma.incident.count({ where })
    ]);

    return toPaginatedResponse(
      items.map((incident) => ({
        ...incident,
        mttaMinutes: this.computeMttaMinutes(incident.createdAt, incident.acknowledgedAt),
        mttrMinutes: this.computeMttrMinutes(incident.createdAt, incident.resolvedAt)
      })),
      query.page,
      query.pageSize,
      totalCount
    );
  }

  async getIncident(authUser: AuthUserContext, incidentId: string) {
    const orgId = getActiveOrgId({ user: authUser });
    const incident = await this.prisma.incident.findFirst({
      where: { id: incidentId, orgId },
      include: {
        owner: {
          select: { id: true, name: true, email: true, role: true }
        },
        participants: {
          include: {
            user: {
              select: { id: true, name: true, email: true, role: true }
            }
          },
          orderBy: [{ createdAt: "asc" }]
        },
        timeline: {
          include: {
            actorUser: {
              select: { id: true, name: true, email: true, role: true }
            }
          },
          orderBy: [{ createdAt: "asc" }]
        }
      }
    });

    if (!incident) {
      throw new NotFoundException("Incident not found");
    }

    return {
      ...incident,
      mttaMinutes: this.computeMttaMinutes(incident.createdAt, incident.acknowledgedAt),
      mttrMinutes: this.computeMttrMinutes(incident.createdAt, incident.resolvedAt)
    };
  }

  async acknowledgeIncident(authUser: AuthUserContext, incidentId: string) {
    const orgId = getActiveOrgId({ user: authUser });
    const incident = await this.assertIncident(orgId, incidentId);

    await this.assertCanAcknowledge(authUser, orgId);

    const now = new Date();
    const updated = await this.prisma.incident.update({
      where: { id: incident.id },
      data: {
        ownerUserId: authUser.userId,
        status: "ACKNOWLEDGED",
        acknowledgedAt: now
      }
    });

    await this.prisma.incidentParticipant.upsert({
      where: {
        incidentId_userId: {
          incidentId: incident.id,
          userId: authUser.userId
        }
      },
      update: {
        role: "OWNER"
      },
      create: {
        incidentId: incident.id,
        userId: authUser.userId,
        role: "OWNER"
      }
    });

    await this.addTimelineEntry({
      incidentId: incident.id,
      type: "ACKNOWLEDGED",
      actorUserId: authUser.userId,
      metadata: {
        acknowledgedAt: now.toISOString(),
        mttaMinutes: this.computeMttaMinutes(updated.createdAt, updated.acknowledgedAt)
      }
    });

    await this.activityLogService.log({
      orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.ALERT,
      entityId: incident.id,
      action: "INCIDENT_ACKNOWLEDGED"
    });

    return this.getIncident(authUser, incident.id);
  }

  async resolveIncident(authUser: AuthUserContext, incidentId: string) {
    const orgId = getActiveOrgId({ user: authUser });
    const incident = await this.assertIncident(orgId, incidentId);

    const isAdmin = authUser.role === "CEO" || authUser.role === "ADMIN";
    const isOwner = incident.ownerUserId === authUser.userId;
    if (!isAdmin && !isOwner) {
      throw new ForbiddenException("Only the incident owner or CEO/ADMIN can resolve incidents");
    }

    const now = new Date();
    const updated = await this.prisma.incident.update({
      where: { id: incident.id },
      data: {
        status: "RESOLVED",
        resolvedAt: now
      }
    });

    await this.addTimelineEntry({
      incidentId: incident.id,
      type: "RESOLVED",
      actorUserId: authUser.userId,
      metadata: {
        resolvedAt: now.toISOString(),
        mttrMinutes: this.computeMttrMinutes(updated.createdAt, updated.resolvedAt)
      }
    });

    await this.activityLogService.log({
      orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.ALERT,
      entityId: incident.id,
      action: "INCIDENT_RESOLVED"
    });

    return this.getIncident(authUser, incident.id);
  }

  async updateIncidentSeverity(
    authUser: AuthUserContext,
    incidentId: string,
    dto: UpdateIncidentSeverityDto
  ) {
    const orgId = getActiveOrgId({ user: authUser });
    const incident = await this.assertIncident(orgId, incidentId);

    if (authUser.role !== "CEO" && authUser.role !== "ADMIN") {
      throw new ForbiddenException("Only CEO/ADMIN can change incident severity");
    }

    if (incident.severity === dto.severity) {
      return this.getIncident(authUser, incident.id);
    }

    const previousSeverity = incident.severity;
    await this.prisma.incident.update({
      where: { id: incident.id },
      data: { severity: dto.severity }
    });

    await this.addTimelineEntry({
      incidentId: incident.id,
      type: "SEVERITY_CHANGED",
      actorUserId: authUser.userId,
      metadata: {
        before: previousSeverity,
        after: dto.severity
      },
      message: `Severity changed from ${previousSeverity} to ${dto.severity}`
    });

    return this.getIncident(authUser, incident.id);
  }

  async addIncidentNote(authUser: AuthUserContext, incidentId: string, dto: IncidentNoteDto) {
    const orgId = getActiveOrgId({ user: authUser });
    const incident = await this.assertIncident(orgId, incidentId);

    await this.addTimelineEntry({
      incidentId: incident.id,
      type: "NOTE",
      actorUserId: authUser.userId,
      message: dto.message.trim()
    });

    return { success: true };
  }

  async getPostmortem(authUser: AuthUserContext, incidentId: string) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.assertIncident(orgId, incidentId);

    return this.prisma.incidentPostmortem.findUnique({
      where: { incidentId }
    });
  }

  async upsertPostmortem(
    authUser: AuthUserContext,
    incidentId: string,
    dto: UpsertIncidentPostmortemDto
  ) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.assertIncident(orgId, incidentId);

    if (authUser.role !== "CEO" && authUser.role !== "ADMIN") {
      throw new ForbiddenException("Only CEO/ADMIN can manage postmortems");
    }

    const postmortem = await this.prisma.incidentPostmortem.upsert({
      where: { incidentId },
      update: {
        summary: dto.summary,
        rootCause: dto.rootCause,
        impact: dto.impact,
        detectionGap: dto.detectionGap,
        correctiveActions:
          dto.correctiveActions === undefined
            ? undefined
            : (dto.correctiveActions as Prisma.InputJsonValue)
      },
      create: {
        incidentId,
        orgId,
        summary: dto.summary,
        rootCause: dto.rootCause,
        impact: dto.impact,
        detectionGap: dto.detectionGap,
        correctiveActions:
          dto.correctiveActions === undefined
            ? Prisma.JsonNull
            : (dto.correctiveActions as Prisma.InputJsonValue)
      }
    });

    await this.prisma.incident.update({
      where: { id: incidentId },
      data: { status: "POSTMORTEM" }
    });

    await this.addTimelineEntry({
      incidentId,
      type: "NOTE",
      actorUserId: authUser.userId,
      message: "Postmortem updated"
    });

    return postmortem;
  }

  async publishIncident(authUser: AuthUserContext, incidentId: string, dto: PublishIncidentDto) {
    const orgId = getActiveOrgId({ user: authUser });
    const incident = await this.assertIncident(orgId, incidentId);
    const slug = await this.generateUniquePublicSlug(incident.title, incident.id);
    const componentKeys = this.normalizeComponentKeys(dto.componentKeys ?? []);

    const currentUpdates = this.normalizePublicUpdates(incident.publicUpdates);
    const nextUpdates = [
      ...currentUpdates,
      {
        ts: new Date().toISOString(),
        message: dto.publicSummary.trim()
      }
    ];

    const updated = await this.prisma.incident.update({
      where: { id: incident.id },
      data: {
        isPublic: true,
        publicSummary: dto.publicSummary.trim(),
        publicSlug: slug,
        publicComponentKeys: componentKeys as Prisma.InputJsonValue,
        publicUpdates: nextUpdates as Prisma.InputJsonValue
      }
    });

    await this.addTimelineEntry({
      incidentId: incident.id,
      type: "NOTE",
      actorUserId: authUser.userId,
      message: "Published to status page",
      metadata: {
        publicSlug: slug,
        componentKeys
      }
    });

    return updated;
  }

  async unpublishIncident(authUser: AuthUserContext, incidentId: string) {
    const orgId = getActiveOrgId({ user: authUser });
    const incident = await this.assertIncident(orgId, incidentId);
    const updated = await this.prisma.incident.update({
      where: { id: incident.id },
      data: {
        isPublic: false
      }
    });

    await this.addTimelineEntry({
      incidentId: incident.id,
      type: "NOTE",
      actorUserId: authUser.userId,
      message: "Unpublished from status page"
    });

    return updated;
  }

  async addPublicUpdate(authUser: AuthUserContext, incidentId: string, dto: PublicIncidentUpdateDto) {
    const orgId = getActiveOrgId({ user: authUser });
    const incident = await this.assertIncident(orgId, incidentId);
    if (!incident.isPublic) {
      throw new BadRequestException("Incident is not public");
    }

    const updates = this.normalizePublicUpdates(incident.publicUpdates);
    const next = [
      ...updates,
      {
        ts: new Date().toISOString(),
        message: dto.message.trim()
      }
    ];

    const updated = await this.prisma.incident.update({
      where: { id: incident.id },
      data: {
        publicUpdates: next as Prisma.InputJsonValue
      }
    });

    await this.addTimelineEntry({
      incidentId: incident.id,
      type: "NOTE",
      actorUserId: authUser.userId,
      message: `Public update: ${dto.message.trim()}`
    });

    return updated;
  }

  async getMetrics(authUser: AuthUserContext, query: IncidentMetricsQueryDto) {
    const orgId = getActiveOrgId({ user: authUser });
    const rangeDays = this.parseRangeDays(query.range);
    const cutoff = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000);

    const [allInRange, openIncidents, resolvedInRange] = await Promise.all([
      this.prisma.incident.findMany({
        where: { orgId, createdAt: { gte: cutoff } },
        select: {
          id: true,
          createdAt: true,
          acknowledgedAt: true,
          resolvedAt: true,
          status: true
        }
      }),
      this.prisma.incident.count({ where: { orgId, status: { in: ["OPEN", "ACKNOWLEDGED"] } } }),
      this.prisma.incident.count({ where: { orgId, status: { in: ["RESOLVED", "POSTMORTEM"] }, createdAt: { gte: cutoff } } })
    ]);

    const mttaSamples = allInRange
      .map((incident) => this.computeMttaMinutes(incident.createdAt, incident.acknowledgedAt))
      .filter((value): value is number => typeof value === "number");

    const mttrSamples = allInRange
      .map((incident) => this.computeMttrMinutes(incident.createdAt, incident.resolvedAt))
      .filter((value): value is number => typeof value === "number");

    return {
      totalIncidents: allInRange.length,
      avgMTTA: this.average(mttaSamples),
      avgMTTR: this.average(mttrSamples),
      openIncidents,
      resolvedIncidents: resolvedInRange,
      rangeDays
    };
  }

  async createIncidentFromAlertEvent(alertEventId: string): Promise<void> {
    const alertEvent = await this.prisma.alertEvent.findUnique({
      where: { id: alertEventId },
      include: {
        rule: {
          select: {
            autoCreateIncident: true
          }
        }
      }
    });

    if (!alertEvent) {
      return;
    }

    const severity = this.normalizeSeverity(alertEvent.severity);
    const shouldCreate =
      severity === "CRITICAL" || (severity === "HIGH" && Boolean(alertEvent.rule?.autoCreateIncident));

    if (!shouldCreate) {
      return;
    }

    const existing = await this.prisma.incident.findFirst({
      where: {
        orgId: alertEvent.orgId,
        alertEventId: alertEvent.id
      },
      select: { id: true }
    });

    if (existing) {
      return;
    }

    const incident = await this.prisma.incident.create({
      data: {
        orgId: alertEvent.orgId,
        alertEventId: alertEvent.id,
        title: alertEvent.title,
        severity,
        status: "OPEN"
      }
    });

    await this.addTimelineEntry({
      incidentId: incident.id,
      type: "CREATED",
      message: "Incident auto-created from alert",
      metadata: {
        alertEventId: alertEvent.id,
        severity: alertEvent.severity,
        alertType: alertEvent.type
      }
    });
  }

  async addEscalationTimelineByAlertEventId(
    alertEventId: string,
    metadata: { stepNumber: number; routedTo: string[]; suppressed: boolean; reason?: string | null }
  ): Promise<void> {
    const incident = await this.prisma.incident.findFirst({
      where: {
        alertEventId,
        status: { in: ["OPEN", "ACKNOWLEDGED"] }
      },
      select: { id: true }
    });

    if (!incident) {
      return;
    }

    await this.addTimelineEntry({
      incidentId: incident.id,
      type: "ESCALATED",
      message: metadata.suppressed ? "Escalation suppressed" : "Escalation step executed",
      metadata
    });
  }

  async addMitigationTimelineByAlertEventId(
    alertEventId: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    const incident = await this.prisma.incident.findFirst({
      where: {
        alertEventId,
        status: { in: ["OPEN", "ACKNOWLEDGED"] }
      },
      select: { id: true }
    });

    if (!incident) {
      return;
    }

    await this.addTimelineEntry({
      incidentId: incident.id,
      type: "MITIGATION",
      message: "Auto-mitigation applied",
      metadata
    });
  }

  private async assertIncident(orgId: string, incidentId: string) {
    const incident = await this.prisma.incident.findFirst({
      where: { id: incidentId, orgId }
    });

    if (!incident) {
      throw new NotFoundException("Incident not found");
    }

    return incident;
  }

  private async assertCanAcknowledge(authUser: AuthUserContext, orgId: string): Promise<void> {
    if (authUser.role === "CEO" || authUser.role === "ADMIN") {
      return;
    }

    const resolved = await this.onCallResolver.resolveNow(orgId);
    if (resolved.primaryUserId === authUser.userId) {
      return;
    }

    throw new ForbiddenException("Only CEO/ADMIN or current on-call primary can acknowledge incidents");
  }

  private normalizeSeverity(value: string): "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" {
    const normalized = value.toUpperCase();
    if (INCIDENT_SEVERITIES.includes(normalized as (typeof INCIDENT_SEVERITIES)[number])) {
      return normalized as "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
    }
    return "HIGH";
  }

  private parseRangeDays(range?: string): number {
    if (!range) {
      return 30;
    }
    const trimmed = range.trim().toLowerCase();
    const value = Number.parseInt(trimmed.replace("d", ""), 10);
    if (!Number.isFinite(value) || value <= 0) {
      throw new BadRequestException("Invalid range, expected format like 30d");
    }
    return Math.min(value, 365);
  }

  private async generateUniquePublicSlug(title: string, incidentId: string): Promise<string> {
    const base = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "incident";

    const suffix = incidentId.slice(0, 8);
    let candidate = `${base}-${suffix}`;
    let counter = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const conflict = await this.prisma.incident.findFirst({
        where: { publicSlug: candidate, NOT: { id: incidentId } },
        select: { id: true }
      });
      if (!conflict) {
        return candidate;
      }
      counter += 1;
      candidate = `${base}-${suffix}-${counter}`;
    }
  }

  private normalizePublicUpdates(value: Prisma.JsonValue | null): Array<{ ts: string; message: string }> {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const row = entry as Record<string, unknown>;
        const ts = typeof row.ts === "string" ? row.ts : null;
        const message = typeof row.message === "string" ? row.message : null;
        if (!ts || !message) {
          return null;
        }
        return { ts, message };
      })
      .filter((entry): entry is { ts: string; message: string } => Boolean(entry));
  }

  private normalizeComponentKeys(value: string[]): string[] {
    const allowed = new Set(["api", "web", "db", "webhooks", "ai", "billing"]);
    return value
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => allowed.has(entry));
  }

  private computeMttaMinutes(createdAt: Date, acknowledgedAt?: Date | null): number | null {
    if (!acknowledgedAt) {
      return null;
    }
    return Math.max(0, Math.round((acknowledgedAt.getTime() - createdAt.getTime()) / 60_000));
  }

  private computeMttrMinutes(createdAt: Date, resolvedAt?: Date | null): number | null {
    if (!resolvedAt) {
      return null;
    }
    return Math.max(0, Math.round((resolvedAt.getTime() - createdAt.getTime()) / 60_000));
  }

  private average(values: number[]): number {
    if (values.length === 0) {
      return 0;
    }
    const total = values.reduce((sum, value) => sum + value, 0);
    return Math.round((total / values.length) * 10) / 10;
  }

  private async addTimelineEntry(input: {
    incidentId: string;
    type: string;
    message?: string;
    metadata?: Record<string, unknown>;
    actorUserId?: string;
  }): Promise<void> {
    await this.prisma.incidentTimeline.create({
      data: {
        incidentId: input.incidentId,
        type: input.type,
        message: input.message,
        metadata:
          input.metadata === undefined
            ? undefined
            : (input.metadata as Prisma.InputJsonValue),
        actorUserId: input.actorUserId
      }
    });
  }
}
