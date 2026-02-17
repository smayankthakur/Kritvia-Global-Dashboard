import { Injectable, Logger } from "@nestjs/common";
import { ActivityEntityType, Prisma } from "@prisma/client";
import { ActivityLogService } from "../activity-log/activity-log.service";
import { IncidentsService } from "../incidents/incidents.service";
import { PrismaService } from "../prisma/prisma.service";
import { AlertRoutingService } from "./alert-routing.service";
import { AlertFailureMeta, AlertType, DEFAULT_ALERT_RULES } from "./alerts.constants";

@Injectable()
export class AlertingService {
  private readonly logger = new Logger(AlertingService.name);
  private readonly counterState = new Map<string, Array<number>>();
  private readonly openCircuits = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly activityLogService: ActivityLogService,
    private readonly alertRoutingService: AlertRoutingService,
    private readonly incidentsService: IncidentsService
  ) {}

  async ensureDefaultRulesForOrg(orgId: string): Promise<void> {
    const existing = await this.prisma.alertRule.findMany({
      where: { orgId },
      select: { type: true }
    });
    const existingTypes = new Set(existing.map((rule) => rule.type));
    const missing = DEFAULT_ALERT_RULES.filter((rule) => !existingTypes.has(rule.type));
    if (missing.length === 0) {
      return;
    }

    await this.prisma.alertRule.createMany({
      data: missing.map((rule) => ({
        orgId,
        type: rule.type,
        isEnabled: true,
        thresholdCount: rule.thresholdCount,
        windowMinutes: rule.windowMinutes,
        severity: rule.severity,
        autoCreateIncident: false,
        autoMitigation: rule.autoMitigation as Prisma.InputJsonValue | undefined
      }))
    });
  }

  async recordFailure(type: AlertType, orgId: string, meta: AlertFailureMeta = {}): Promise<void> {
    await this.ensureDefaultRulesForOrg(orgId);

    const rule = await this.prisma.alertRule.findFirst({
      where: {
        orgId,
        type,
        isEnabled: true
      }
    });

    if (!rule) {
      return;
    }

    const now = Date.now();
    const windowMs = Math.max(rule.windowMinutes, 1) * 60_000;
    const cutoff = now - windowMs;
    const key = `${orgId}:${type}`;
    const timestamps = this.counterState.get(key) ?? [];
    const nextWindow = timestamps.filter((entry) => entry >= cutoff);
    nextWindow.push(now);
    this.counterState.set(key, nextWindow);

    if (nextWindow.length < rule.thresholdCount) {
      return;
    }

    const recentExisting = await this.prisma.alertEvent.findFirst({
      where: {
        orgId,
        type,
        createdAt: {
          gte: new Date(cutoff)
        }
      },
      select: { id: true }
    });

    if (recentExisting) {
      return;
    }

    const mitigation = await this.applyAutoMitigation(orgId, rule.autoMitigation, meta);

    const details = {
      ...meta,
      thresholdCount: rule.thresholdCount,
      windowMinutes: rule.windowMinutes,
      observedCount: nextWindow.length,
      autoMitigationApplied: mitigation
    };

    const createdEvent = await this.prisma.alertEvent.create({
      data: {
        orgId,
        ruleId: rule.id,
        type,
        severity: rule.severity,
        title: this.alertTitle(type),
        details: details as Prisma.InputJsonValue
      }
    });
    await this.incidentsService.createIncidentFromAlertEvent(createdEvent.id);
    if (mitigation && mitigation.status === "applied") {
      await this.incidentsService.addMitigationTimelineByAlertEventId(createdEvent.id, mitigation);
    }

    await this.alertRoutingService.queueRouteForAlertEvent(createdEvent.id).catch((error) => {
      this.logger.warn(
        `alert delivery enqueue failed for alertEvent=${createdEvent.id}: ${
          error instanceof Error ? error.message : "unknown"
        }`
      );
    });

    this.logger.warn(
      `alert type=${type} orgId=${orgId} observed=${nextWindow.length} threshold=${rule.thresholdCount}`
    );
  }

  async getOpenCircuitKeys(orgId: string): Promise<string[]> {
    const prefix = `${orgId}:`;
    return Array.from(this.openCircuits.keys()).filter((key) => key.startsWith(prefix));
  }

  private alertTitle(type: AlertType): string {
    switch (type) {
      case "JOB_FAILURE_SPIKE":
        return "Job failures spiking";
      case "WEBHOOK_FAILURE_SPIKE":
        return "Webhook delivery failures spiking";
      case "APP_COMMAND_FAILURE_SPIKE":
        return "App command failures spiking";
      case "OAUTH_REFRESH_FAILURE":
        return "OAuth refresh failures detected";
      default:
        return "Operational alert triggered";
    }
  }

  private async applyAutoMitigation(
    orgId: string,
    mitigation: Prisma.JsonValue | null,
    meta: AlertFailureMeta
  ): Promise<{ action: string; status: string; targetId?: string } | null> {
    if (!mitigation || typeof mitigation !== "object" || Array.isArray(mitigation)) {
      return null;
    }

    const action =
      "action" in mitigation && typeof mitigation.action === "string"
        ? mitigation.action
        : undefined;

    if (!action) {
      return null;
    }

    if (action === "DISABLE_WEBHOOK") {
      const endpointId = typeof meta.endpointId === "string" ? meta.endpointId : undefined;
      if (!endpointId) {
        return { action, status: "skipped" };
      }

      const update = await this.prisma.webhookEndpoint.updateMany({
        where: {
          id: endpointId,
          orgId,
          isActive: true
        },
        data: {
          isActive: false,
          lastFailureAt: new Date()
        }
      });

      if (update.count > 0) {
        await this.activityLogService.log({
          orgId,
          entityType: ActivityEntityType.WEBHOOK,
          entityId: endpointId,
          action: "WEBHOOK_AUTO_DISABLED",
          after: {
            endpointId,
            reason: "Alert auto mitigation"
          }
        });
      }

      return {
        action,
        status: update.count > 0 ? "applied" : "noop",
        targetId: endpointId
      };
    }

    if (action === "PAUSE_APP_INSTALL") {
      const appInstallId = typeof meta.appInstallId === "string" ? meta.appInstallId : undefined;
      if (!appInstallId) {
        return { action, status: "skipped" };
      }

      const update = await this.prisma.orgAppInstall.updateMany({
        where: {
          id: appInstallId,
          orgId,
          status: { not: "DISABLED" }
        },
        data: {
          status: "DISABLED",
          disabledAt: new Date()
        }
      });

      if (update.count > 0) {
        await this.activityLogService.log({
          orgId,
          entityType: ActivityEntityType.APP,
          entityId: appInstallId,
          action: "APP_AUTO_DISABLED",
          after: {
            appInstallId,
            reason: "Alert auto mitigation"
          }
        });
      }

      return {
        action,
        status: update.count > 0 ? "applied" : "noop",
        targetId: appInstallId
      };
    }

    if (action === "OPEN_CIRCUIT") {
      const circuitKeyInput =
        typeof meta.endpointId === "string"
          ? `webhook:${meta.endpointId}`
          : typeof meta.appInstallId === "string"
            ? `app:${meta.appInstallId}`
            : `org:${orgId}`;
      const key = `${orgId}:${circuitKeyInput}`;
      this.openCircuits.set(key, Date.now());
      return {
        action,
        status: "applied",
        targetId: key
      };
    }

    return { action, status: "skipped" };
  }
}
