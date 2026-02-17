import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ActivityEntityType, Prisma } from "@prisma/client";
import { AuthUserContext } from "../auth/auth.types";
import { BillingService } from "../billing/billing.service";
import { getActiveOrgId } from "../common/auth-org";
import { toPaginatedResponse } from "../common/dto/paginated-response.dto";
import { IncidentsService } from "../incidents/incidents.service";
import { encryptAppConfig } from "../marketplace/app-config-crypto.util";
import { OnCallResolver } from "../oncall/oncall.resolver";
import { PrismaService } from "../prisma/prisma.service";
import { ActivityLogService } from "../activity-log/activity-log.service";
import { AlertRoutingService } from "./alert-routing.service";
import {
  DEFAULT_ESCALATION_POLICY_STEPS,
  EscalationStep
} from "./alerts.constants";
import {
  CreateAlertChannelDto,
  TestAlertChannelDto,
  UpdateAlertChannelDto
} from "./dto/alert-channel.dto";
import {
  TestEscalationPolicyDto,
  UpsertEscalationPolicyDto
} from "./dto/escalation-policy.dto";
import { ListAlertDeliveriesQueryDto } from "./dto/list-alert-deliveries-query.dto";
import { ListAlertsQueryDto } from "./dto/list-alerts-query.dto";
import { UpdateAlertRuleDto } from "./dto/update-alert-rule.dto";
import { AlertingService } from "./alerting.service";

const SEVERITY_WEIGHT: Record<string, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3
};

const ESCALATION_COOLDOWN_MINUTES = 10;

@Injectable()
export class AlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billingService: BillingService,
    private readonly alertingService: AlertingService,
    private readonly alertRoutingService: AlertRoutingService,
    private readonly activityLogService: ActivityLogService,
    private readonly onCallResolver: OnCallResolver,
    private readonly incidentsService: IncidentsService
  ) {}

  async listAlerts(authUser: AuthUserContext, query: ListAlertsQueryDto) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");
    await this.alertingService.ensureDefaultRulesForOrg(orgId);

    const skip = (query.page - 1) * query.pageSize;
    const where = {
      orgId,
      ...(query.acknowledged ? {} : { isAcknowledged: false })
    };

    const [items, totalCount] = await this.prisma.$transaction([
      this.prisma.alertEvent.findMany({
        where,
        orderBy: [{ createdAt: "desc" }],
        skip,
        take: query.pageSize
      }),
      this.prisma.alertEvent.count({ where })
    ]);

    return toPaginatedResponse(items, query.page, query.pageSize, totalCount);
  }

  async acknowledge(authUser: AuthUserContext, id: string) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");

    const updated = await this.prisma.alertEvent.updateMany({
      where: {
        id,
        orgId,
        isAcknowledged: false
      },
      data: {
        isAcknowledged: true,
        acknowledgedByUserId: authUser.userId,
        acknowledgedAt: new Date()
      }
    });

    if (updated.count === 0) {
      const exists = await this.prisma.alertEvent.findFirst({
        where: {
          id,
          orgId
        },
        select: { id: true }
      });
      if (!exists) {
        throw new NotFoundException("Alert not found");
      }
    }

    await this.activityLogService.log({
      orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.ALERT,
      entityId: id,
      action: "ALERT_ACKNOWLEDGED",
      after: {
        isAcknowledged: true,
        acknowledgedAt: new Date().toISOString()
      }
    });

    return this.prisma.alertEvent.findFirst({
      where: {
        id,
        orgId
      }
    });
  }

  async listRules(authUser: AuthUserContext) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");
    await this.alertingService.ensureDefaultRulesForOrg(orgId);
    return this.prisma.alertRule.findMany({
      where: { orgId },
      orderBy: [{ type: "asc" }]
    });
  }

  async updateRule(authUser: AuthUserContext, id: string, dto: UpdateAlertRuleDto) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");

    const existing = await this.prisma.alertRule.findFirst({
      where: {
        id,
        orgId
      },
      select: { id: true }
    });

    if (!existing) {
      throw new NotFoundException("Alert rule not found");
    }

    return this.prisma.alertRule.update({
      where: { id },
      data: {
        isEnabled: dto.isEnabled,
        thresholdCount: dto.thresholdCount,
        windowMinutes: dto.windowMinutes,
        severity: dto.severity,
        autoCreateIncident: dto.autoCreateIncident,
        autoMitigation:
          dto.autoMitigation === undefined
            ? undefined
            : dto.autoMitigation === null
              ? Prisma.JsonNull
              : (dto.autoMitigation as Prisma.InputJsonValue)
      }
    });
  }

  async listChannels(authUser: AuthUserContext) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");
    const channels = await this.prisma.alertChannel.findMany({
      where: { orgId },
      orderBy: [{ createdAt: "desc" }]
    });

    return channels.map((channel) => ({
      id: channel.id,
      orgId: channel.orgId,
      type: channel.type,
      name: channel.name,
      isEnabled: channel.isEnabled,
      minSeverity: channel.minSeverity,
      hasConfig: Boolean(channel.configEncrypted),
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt
    }));
  }

  async createChannel(authUser: AuthUserContext, dto: CreateAlertChannelDto) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");
    try {
      this.alertRoutingService.validateChannelConfig(dto.type, dto.config ?? {});
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "Invalid channel config");
    }

    const created = await this.prisma.alertChannel.create({
      data: {
        orgId,
        type: dto.type,
        name: dto.name.trim(),
        minSeverity: dto.minSeverity,
        configEncrypted: encryptAppConfig(dto.config ?? {})
      }
    });

    return {
      id: created.id,
      orgId: created.orgId,
      type: created.type,
      name: created.name,
      isEnabled: created.isEnabled,
      minSeverity: created.minSeverity,
      hasConfig: Boolean(created.configEncrypted),
      createdAt: created.createdAt,
      updatedAt: created.updatedAt
    };
  }

  async updateChannel(authUser: AuthUserContext, id: string, dto: UpdateAlertChannelDto) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");

    const existing = await this.prisma.alertChannel.findFirst({
      where: { id, orgId }
    });

    if (!existing) {
      throw new NotFoundException("Alert channel not found");
    }

    if (dto.config) {
      try {
        this.alertRoutingService.validateChannelConfig(existing.type, dto.config);
      } catch (error) {
        throw new BadRequestException(
          error instanceof Error ? error.message : "Invalid channel config"
        );
      }
    }

    const updated = await this.prisma.alertChannel.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        isEnabled: dto.isEnabled,
        minSeverity: dto.minSeverity,
        configEncrypted: dto.config ? encryptAppConfig(dto.config) : undefined
      }
    });

    return {
      id: updated.id,
      orgId: updated.orgId,
      type: updated.type,
      name: updated.name,
      isEnabled: updated.isEnabled,
      minSeverity: updated.minSeverity,
      hasConfig: Boolean(updated.configEncrypted),
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt
    };
  }

  async deleteChannel(authUser: AuthUserContext, id: string): Promise<{ success: true }> {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");
    const deleted = await this.prisma.alertChannel.deleteMany({
      where: {
        id,
        orgId
      }
    });

    if (deleted.count === 0) {
      throw new NotFoundException("Alert channel not found");
    }

    return { success: true };
  }

  async listDeliveries(authUser: AuthUserContext, query: ListAlertDeliveriesQueryDto) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");

    const skip = (query.page - 1) * query.pageSize;
    const where = {
      orgId,
      ...(query.alertEventId ? { alertEventId: query.alertEventId } : {})
    };

    const [items, totalCount] = await this.prisma.$transaction([
      this.prisma.alertDelivery.findMany({
        where,
        orderBy: [{ createdAt: "desc" }],
        skip,
        take: query.pageSize,
        include: {
          channel: {
            select: {
              id: true,
              name: true,
              type: true
            }
          }
        }
      }),
      this.prisma.alertDelivery.count({ where })
    ]);

    return toPaginatedResponse(items, query.page, query.pageSize, totalCount);
  }

  async testChannel(authUser: AuthUserContext, id: string, dto: TestAlertChannelDto) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");

    const channel = await this.prisma.alertChannel.findFirst({
      where: { id, orgId },
      select: { id: true }
    });

    if (!channel) {
      throw new NotFoundException("Alert channel not found");
    }

    const delivery = await this.alertRoutingService.sendTest(
      id,
      orgId,
      dto.severity ?? "HIGH"
    );

    return {
      success: Boolean(delivery?.success),
      delivery
    };
  }

  async getEscalationPolicy(authUser: AuthUserContext) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");
    return this.ensureEscalationPolicyForOrg(orgId);
  }

  async createEscalationPolicy(authUser: AuthUserContext, dto: UpsertEscalationPolicyDto) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");

    const existing = await this.ensureEscalationPolicyForOrg(orgId);
    return this.prisma.escalationPolicy.update({
      where: { id: existing.id },
      data: this.buildEscalationPolicyUpdateData(dto)
    });
  }

  async updateEscalationPolicy(authUser: AuthUserContext, id: string, dto: UpsertEscalationPolicyDto) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");

    const existing = await this.prisma.escalationPolicy.findFirst({
      where: { id, orgId },
      select: { id: true }
    });

    if (!existing) {
      throw new NotFoundException("Escalation policy not found");
    }

    return this.prisma.escalationPolicy.update({
      where: { id },
      data: this.buildEscalationPolicyUpdateData(dto)
    });
  }

  async listEscalationsForAlert(authUser: AuthUserContext, alertId: string) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");

    const alert = await this.prisma.alertEvent.findFirst({
      where: { id: alertId, orgId },
      select: { id: true }
    });

    if (!alert) {
      throw new NotFoundException("Alert not found");
    }

    return this.prisma.alertEscalation.findMany({
      where: { orgId, alertEventId: alertId },
      orderBy: [{ attemptedAt: "asc" }, { stepNumber: "asc" }]
    });
  }

  async testEscalationPolicy(authUser: AuthUserContext, dto: TestEscalationPolicyDto) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");
    await this.ensureEscalationPolicyForOrg(orgId);

    const event = await this.prisma.alertEvent.create({
      data: {
        orgId,
        type: "ESCALATION_TEST",
        severity: dto.severity ?? "HIGH",
        title: "Escalation policy test alert",
        details: {
          source: "manual-escalation-test"
        }
      }
    });
    await this.incidentsService.createIncidentFromAlertEvent(event.id);

    const scan = await this.runEscalationScanForOrg(orgId, new Date(), {
      alertIds: [event.id],
      force: true
    });

    return {
      alertEventId: event.id,
      escalated: scan.escalated,
      suppressed: scan.suppressed,
      totalProcessed: scan.totalProcessed
    };
  }

  async runEscalationScan(now: Date = new Date()): Promise<{
    processedOrgs: number;
    totalProcessed: number;
    escalated: number;
    suppressed: number;
  }> {
    const policies = await this.prisma.escalationPolicy.findMany({
      where: { isEnabled: true },
      select: { orgId: true }
    });

    let totalProcessed = 0;
    let escalated = 0;
    let suppressed = 0;

    for (const policy of policies) {
      const result = await this.runEscalationScanForOrg(policy.orgId, now);
      totalProcessed += result.totalProcessed;
      escalated += result.escalated;
      suppressed += result.suppressed;
    }

    return {
      processedOrgs: policies.length,
      totalProcessed,
      escalated,
      suppressed
    };
  }

  async runEscalationScanForOrg(
    orgId: string,
    now: Date = new Date(),
    options?: { alertIds?: string[]; force?: boolean }
  ): Promise<{ totalProcessed: number; escalated: number; suppressed: number }> {
    const policy = await this.ensureEscalationPolicyForOrg(orgId);
    if (!policy.isEnabled) {
      return { totalProcessed: 0, escalated: 0, suppressed: 0 };
    }

    const alerts = await this.prisma.alertEvent.findMany({
      where: {
        orgId,
        isAcknowledged: false,
        createdAt: {
          gte: new Date(now.getTime() - 48 * 60 * 60 * 1000)
        },
        ...(options?.alertIds?.length ? { id: { in: options.alertIds } } : {})
      },
      orderBy: { createdAt: "asc" }
    });

    const steps = this.normalizeEscalationSteps(policy.steps);
    if (steps.length === 0) {
      return { totalProcessed: alerts.length, escalated: 0, suppressed: 0 };
    }

    let escalated = 0;
    let suppressed = 0;

    for (const alert of alerts) {
      const elapsedMinutes = Math.floor((now.getTime() - alert.createdAt.getTime()) / 60_000);
      const slaMinutes = this.getSlaMinutes(policy, alert.severity);
      const dueSteps = steps
        .map((step, index) => ({ ...step, stepNumber: index + 1 }))
        .filter((step) => {
          if (!this.isSeverityEligible(alert.severity, step.minSeverity)) {
            return false;
          }
          const threshold = Math.max(step.afterMinutes, slaMinutes);
          return options?.force === true ? true : elapsedMinutes >= threshold;
        });

      if (dueSteps.length === 0) {
        continue;
      }

      const existingSteps = await this.prisma.alertEscalation.findMany({
        where: {
          alertEventId: alert.id
        },
        select: {
          stepNumber: true,
          attemptedAt: true
        },
        orderBy: { attemptedAt: "desc" }
      });

      const existingStepSet = new Set(existingSteps.map((entry) => entry.stepNumber));
      const latestAttempt = existingSteps[0];

      if (
        !options?.force &&
        latestAttempt &&
        now.getTime() - latestAttempt.attemptedAt.getTime() < ESCALATION_COOLDOWN_MINUTES * 60_000
      ) {
        continue;
      }

      for (const step of dueSteps) {
        const stepNumber = step.stepNumber;
        if (existingStepSet.has(stepNumber)) {
          continue;
        }

        const suppressionReason = this.getSuppressionReason(policy, now);
        if (suppressionReason) {
          await this.prisma.alertEscalation
            .create({
              data: {
                orgId,
                alertEventId: alert.id,
                stepNumber,
                routedTo: step.routeTo as Prisma.InputJsonValue,
                suppressed: true,
                reason: suppressionReason
              }
            })
            .catch(() => undefined);
          await this.incidentsService.addEscalationTimelineByAlertEventId(alert.id, {
            stepNumber,
            routedTo: step.routeTo,
            suppressed: true,
            reason: suppressionReason
          });
          suppressed += 1;
          continue;
        }

        const onCallEmails = await this.resolveOnCallEmailsForStep(orgId, step.routeTo);
        const channelRoutes = step.routeTo.filter(
          (route) =>
            route !== "ONCALL_PRIMARY_EMAIL" &&
            route !== "ONCALL_SECONDARY_EMAIL" &&
            route !== "ONCALL_PRIMARY" &&
            route !== "ONCALL_SECONDARY" &&
            route !== "ONCALL_PRIMARY_GLOBAL"
        );
        if (this.stepUsesOnCall(step.routeTo) && onCallEmails.length === 0) {
          await this.prisma.alertEscalation
            .create({
              data: {
                orgId,
                alertEventId: alert.id,
                stepNumber,
                routedTo: step.routeTo as Prisma.InputJsonValue,
                suppressed: true,
                reason: "NO_ONCALL_COVERAGE"
              }
            })
            .catch(() => undefined);
          await this.incidentsService.addEscalationTimelineByAlertEventId(alert.id, {
            stepNumber,
            routedTo: step.routeTo,
            suppressed: true,
            reason: "NO_ONCALL_COVERAGE"
          });
          suppressed += 1;
          continue;
        }

        if (onCallEmails.length > 0) {
          channelRoutes.push("EMAIL");
        }
        await this.alertRoutingService.routeAlertToChannels(
          alert.id,
          Array.from(new Set(channelRoutes)),
          onCallEmails.length > 0 ? { emailRecipientsOverride: onCallEmails } : undefined
        );
        await this.prisma.alertEscalation
          .create({
            data: {
              orgId,
              alertEventId: alert.id,
              stepNumber,
              routedTo: step.routeTo as Prisma.InputJsonValue,
              suppressed: false,
              reason: null
            }
          })
          .catch(() => undefined);
        await this.incidentsService.addEscalationTimelineByAlertEventId(alert.id, {
          stepNumber,
          routedTo: step.routeTo,
          suppressed: false,
          reason: null
        });
        escalated += 1;
      }
    }

    return {
      totalProcessed: alerts.length,
      escalated,
      suppressed
    };
  }

  private async ensureEscalationPolicyForOrg(orgId: string) {
    const existing = await this.prisma.escalationPolicy.findFirst({
      where: { orgId }
    });

    if (existing) {
      return existing;
    }

    return this.prisma.escalationPolicy.create({
      data: {
        orgId,
        name: "Default escalation policy",
        timezone: "UTC",
        quietHoursEnabled: false,
        businessDaysOnly: false,
        slaCritical: 10,
        slaHigh: 30,
        slaMedium: 180,
        slaLow: 1440,
        steps: DEFAULT_ESCALATION_POLICY_STEPS as Prisma.InputJsonValue
      }
    });
  }

  private buildEscalationPolicyUpdateData(dto: UpsertEscalationPolicyDto): Prisma.EscalationPolicyUpdateInput {
    if (
      (dto.quietHoursEnabled ?? false) &&
      ((!dto.quietHoursStart && dto.quietHoursStart !== undefined) ||
        (!dto.quietHoursEnd && dto.quietHoursEnd !== undefined))
    ) {
      throw new BadRequestException("Quiet hours start and end are required when quiet hours are enabled");
    }

    return {
      name: dto.name?.trim(),
      isEnabled: dto.isEnabled,
      timezone: dto.timezone?.trim(),
      quietHoursEnabled: dto.quietHoursEnabled,
      quietHoursStart: dto.quietHoursStart,
      quietHoursEnd: dto.quietHoursEnd,
      businessDaysOnly: dto.businessDaysOnly,
      slaCritical: dto.slaCritical,
      slaHigh: dto.slaHigh,
      slaMedium: dto.slaMedium,
      slaLow: dto.slaLow,
      steps: dto.steps
        ? (this.normalizeEscalationSteps(dto.steps as EscalationStep[]) as Prisma.InputJsonValue)
        : undefined
    };
  }

  private normalizeEscalationSteps(raw: unknown): EscalationStep[] {
    if (!Array.isArray(raw)) {
      return [];
    }

    return raw
      .filter((entry): entry is EscalationStep => {
        if (!entry || typeof entry !== "object") {
          return false;
        }
        if (typeof entry.afterMinutes !== "number" || !Number.isFinite(entry.afterMinutes)) {
          return false;
        }
        if (!Array.isArray(entry.routeTo) || entry.routeTo.length === 0) {
          return false;
        }
        if (typeof entry.minSeverity !== "string") {
          return false;
        }
        return true;
      })
      .map((entry) => ({
        afterMinutes: Math.max(1, Math.round(entry.afterMinutes)),
        routeTo: entry.routeTo
          .map((route) => String(route).toUpperCase())
          .filter(
            (route): route is
              | "WEBHOOK"
              | "EMAIL"
              | "SLACK"
              | "ONCALL_PRIMARY"
              | "ONCALL_SECONDARY"
              | "ONCALL_PRIMARY_GLOBAL"
              | "ONCALL_PRIMARY_EMAIL"
              | "ONCALL_SECONDARY_EMAIL" =>
              route === "WEBHOOK" ||
              route === "EMAIL" ||
              route === "SLACK" ||
              route === "ONCALL_PRIMARY" ||
              route === "ONCALL_SECONDARY" ||
              route === "ONCALL_PRIMARY_GLOBAL" ||
              route === "ONCALL_PRIMARY_EMAIL" ||
              route === "ONCALL_SECONDARY_EMAIL"
          ),
        minSeverity: this.normalizeStepSeverity(entry.minSeverity)
      }))
      .filter((entry) => entry.routeTo.length > 0)
      .sort((a, b) => a.afterMinutes - b.afterMinutes);
  }

  private getSuppressionReason(
    policy: {
      timezone: string;
      quietHoursEnabled: boolean;
      quietHoursStart: string | null;
      quietHoursEnd: string | null;
      businessDaysOnly: boolean;
    },
    now: Date
  ): string | null {
    const local = this.getLocalTime(now, policy.timezone);

    if (policy.businessDaysOnly && (local.weekday === "Sat" || local.weekday === "Sun")) {
      return "business-days-only";
    }

    if (policy.quietHoursEnabled && policy.quietHoursStart && policy.quietHoursEnd) {
      const start = this.parseMinutes(policy.quietHoursStart);
      const end = this.parseMinutes(policy.quietHoursEnd);
      if (start !== null && end !== null && this.isInQuietHours(local.minutesOfDay, start, end)) {
        return "quiet-hours";
      }
    }

    return null;
  }

  private getLocalTime(now: Date, timezone: string): {
    weekday: string;
    minutesOfDay: number;
  } {
    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone || "UTC",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      });

      const parts = formatter.formatToParts(now);
      const weekday = parts.find((part) => part.type === "weekday")?.value ?? "Mon";
      const hourValue = Number.parseInt(parts.find((part) => part.type === "hour")?.value ?? "0", 10);
      const minuteValue = Number.parseInt(parts.find((part) => part.type === "minute")?.value ?? "0", 10);
      return {
        weekday,
        minutesOfDay: hourValue * 60 + minuteValue
      };
    } catch {
      return {
        weekday: "Mon",
        minutesOfDay: now.getUTCHours() * 60 + now.getUTCMinutes()
      };
    }
  }

  private parseMinutes(value: string): number | null {
    const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
    if (!match) {
      return null;
    }
    const hours = Number.parseInt(match[1], 10);
    const minutes = Number.parseInt(match[2], 10);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      return null;
    }
    return hours * 60 + minutes;
  }

  private isInQuietHours(minutesOfDay: number, start: number, end: number): boolean {
    if (start === end) {
      return true;
    }
    if (start < end) {
      return minutesOfDay >= start && minutesOfDay < end;
    }
    return minutesOfDay >= start || minutesOfDay < end;
  }

  private async resolveOnCallEmailsForStep(orgId: string, routes: string[]): Promise<string[]> {
    const requiresPrimary =
      routes.includes("ONCALL_PRIMARY_EMAIL") ||
      routes.includes("ONCALL_PRIMARY") ||
      routes.includes("ONCALL_PRIMARY_GLOBAL");
    const requiresSecondary =
      routes.includes("ONCALL_SECONDARY_EMAIL") || routes.includes("ONCALL_SECONDARY");
    if (!requiresPrimary && !requiresSecondary) {
      return [];
    }

    const resolved = await this.onCallResolver.resolveNow(orgId, new Date(), {
      forceFallback: routes.includes("ONCALL_PRIMARY_GLOBAL")
    });
    const targetUserIds = [
      requiresPrimary ? resolved.primaryUserId : null,
      requiresSecondary ? resolved.secondaryUserId : null
    ].filter((entry): entry is string => Boolean(entry));

    if (targetUserIds.length === 0) {
      return [];
    }

    const users = await this.prisma.user.findMany({
      where: {
        orgId,
        id: { in: targetUserIds },
        isActive: true
      },
      select: {
        email: true
      }
    });

    return Array.from(
      new Set(
        users
          .map((entry) => entry.email.trim().toLowerCase())
          .filter((entry) => entry.length > 0)
      )
    );
  }

  private stepUsesOnCall(routes: string[]): boolean {
    return routes.some((route) =>
      [
        "ONCALL_PRIMARY",
        "ONCALL_SECONDARY",
        "ONCALL_PRIMARY_GLOBAL",
        "ONCALL_PRIMARY_EMAIL",
        "ONCALL_SECONDARY_EMAIL"
      ].includes(route)
    );
  }

  private getSlaMinutes(
    policy: {
      slaCritical: number;
      slaHigh: number;
      slaMedium: number;
      slaLow: number;
    },
    severity: string
  ): number {
    const normalized = this.normalizeSeverity(severity);
    if (normalized === "CRITICAL") {
      return policy.slaCritical;
    }
    if (normalized === "HIGH") {
      return policy.slaHigh;
    }
    if (normalized === "MEDIUM") {
      return policy.slaMedium;
    }
    return policy.slaLow;
  }

  private normalizeSeverity(value: string): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
    const normalized = value.toUpperCase();
    if (normalized === "CRITICAL" || normalized === "HIGH" || normalized === "MEDIUM") {
      return normalized;
    }
    return "LOW";
  }

  private normalizeStepSeverity(value: string): "MEDIUM" | "HIGH" | "CRITICAL" {
    const normalized = this.normalizeSeverity(value);
    if (normalized === "CRITICAL" || normalized === "HIGH") {
      return normalized;
    }
    return "MEDIUM";
  }

  private isSeverityEligible(actual: string, minRequired: string): boolean {
    const actualWeight = SEVERITY_WEIGHT[this.normalizeSeverity(actual)] ?? 0;
    const minWeight = SEVERITY_WEIGHT[this.normalizeSeverity(minRequired)] ?? 0;
    return actualWeight >= minWeight;
  }
}
