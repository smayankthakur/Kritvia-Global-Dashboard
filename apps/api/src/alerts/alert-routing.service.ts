import { Inject, Injectable, Logger, forwardRef } from "@nestjs/common";
import { OrgAppInstall } from "@prisma/client";
import { createHmac, randomUUID } from "node:crypto";
import { JobService } from "../jobs/job.service";
import { QUEUE_NAMES } from "../jobs/queues";
import { IncidentsService } from "../incidents/incidents.service";
import { decryptAppConfig } from "../marketplace/app-config-crypto.util";
import { OAuthService } from "../oauth/oauth.service";
import { PrismaService } from "../prisma/prisma.service";

type AlertSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

const SEVERITY_WEIGHT: Record<AlertSeverity, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3
};

const MAX_DELIVERIES_PER_HOUR = 30;

@Injectable()
export class AlertRoutingService {
  private readonly logger = new Logger(AlertRoutingService.name);
  private readonly breakerState = new Map<string, { failCount: number; openUntil?: number }>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => OAuthService))
    private readonly oauthService: OAuthService,
    private readonly jobService: JobService,
    private readonly incidentsService: IncidentsService
  ) {}

  async queueRouteForAlertEvent(alertEventId: string): Promise<void> {
    const alertEvent = await this.prisma.alertEvent.findUnique({
      where: { id: alertEventId },
      select: {
        id: true,
        orgId: true,
        severity: true
      }
    });

    if (!alertEvent) {
      return;
    }

    const channels = await this.prisma.alertChannel.findMany({
      where: {
        orgId: alertEvent.orgId,
        isEnabled: true
      },
      select: {
        id: true,
        minSeverity: true
      }
    });

    const eligibleChannels = channels.filter((channel) =>
      this.isSeverityEligible(alertEvent.severity as AlertSeverity, channel.minSeverity as AlertSeverity)
    );

    for (const channel of eligibleChannels) {
      if ((process.env.JOBS_ENABLED ?? "true").toLowerCase() === "true") {
        await this.jobService.enqueue(
          QUEUE_NAMES.alerts,
          "alert-delivery",
          {
            alertEventId,
            channelId: channel.id,
            orgId: alertEvent.orgId
          },
          { attempts: 1 }
        );
      } else {
        await this.processDeliveryJob({ alertEventId, channelId: channel.id, orgId: alertEvent.orgId });
      }
    }
  }

  async routeAlertToChannels(
    alertEventId: string,
    channelTypes: string[],
    options?: { emailRecipientsOverride?: string[] }
  ): Promise<void> {
    const normalizedTypes = new Set(channelTypes.map((entry) => entry.toUpperCase()));
    if (normalizedTypes.size === 0) {
      return;
    }

    const alertEvent = await this.prisma.alertEvent.findUnique({
      where: { id: alertEventId },
      select: {
        id: true,
        orgId: true,
        severity: true
      }
    });

    if (!alertEvent) {
      return;
    }

    const channels = await this.prisma.alertChannel.findMany({
      where: {
        orgId: alertEvent.orgId,
        isEnabled: true
      },
      select: {
        id: true,
        type: true,
        minSeverity: true
      }
    });

    const eligibleChannels = channels.filter(
      (channel) =>
        normalizedTypes.has(channel.type.toUpperCase()) &&
        this.isSeverityEligible(
          (alertEvent.severity as AlertSeverity) ?? "MEDIUM",
          (channel.minSeverity as AlertSeverity) ?? "MEDIUM"
        )
    );

    for (const channel of eligibleChannels) {
      if ((process.env.JOBS_ENABLED ?? "true").toLowerCase() === "true") {
        await this.jobService.enqueue(
          QUEUE_NAMES.alerts,
          "alert-delivery",
          {
            alertEventId,
            channelId: channel.id,
            orgId: alertEvent.orgId,
            emailRecipientsOverride: options?.emailRecipientsOverride ?? undefined
          },
          { attempts: 1 }
        );
      } else {
        await this.processDeliveryJob({
          alertEventId,
          channelId: channel.id,
          orgId: alertEvent.orgId,
          emailRecipientsOverride: options?.emailRecipientsOverride ?? undefined
        });
      }
    }
  }

  async processDeliveryJob(payload: Record<string, unknown>): Promise<{ success: boolean }> {
    const alertEventId = String(payload.alertEventId ?? "");
    const channelId = String(payload.channelId ?? "");
    const orgId = String(payload.orgId ?? "");
    const emailRecipientsOverride = Array.isArray(payload.emailRecipientsOverride)
      ? payload.emailRecipientsOverride
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : undefined;
    if (!alertEventId || !channelId || !orgId) {
      return { success: false };
    }

    const existing = await this.prisma.alertDelivery.findFirst({
      where: { alertEventId, channelId },
      select: { id: true }
    });
    if (existing) {
      return { success: true };
    }

    const [alertEvent, channel] = await Promise.all([
      this.prisma.alertEvent.findFirst({
        where: { id: alertEventId, orgId },
        select: {
          id: true,
          orgId: true,
          type: true,
          severity: true,
          title: true,
          details: true,
          createdAt: true
        }
      }),
      this.prisma.alertChannel.findFirst({
        where: { id: channelId, orgId },
        select: {
          id: true,
          orgId: true,
          type: true,
          name: true,
          isEnabled: true,
          minSeverity: true,
          configEncrypted: true
        }
      })
    ]);

    if (!alertEvent || !channel || !channel.isEnabled) {
      return { success: false };
    }

    if (!this.isSeverityEligible(alertEvent.severity as AlertSeverity, channel.minSeverity as AlertSeverity)) {
      return { success: false };
    }

    const hourAgo = new Date(Date.now() - 60 * 60_000);
    const usedThisHour = await this.prisma.alertDelivery.count({
      where: {
        orgId,
        createdAt: { gte: hourAgo }
      }
    });

    if (usedThisHour >= MAX_DELIVERIES_PER_HOUR) {
      await this.persistDelivery({
        orgId,
        alertEventId,
        channelId,
        success: false,
        error: "DELIVERY_RATE_LIMIT"
      });
      return { success: false };
    }

    const breaker = this.breakerState.get(channelId);
    if (breaker?.openUntil && breaker.openUntil > Date.now()) {
      await this.persistDelivery({
        orgId,
        alertEventId,
        channelId,
        success: false,
        error: "CIRCUIT_OPEN"
      });
      return { success: false };
    }

    const started = Date.now();

    try {
      const config = channel.configEncrypted ? decryptAppConfig(channel.configEncrypted) : {};
      const statusCode = await this.deliverByChannelType(channel.type, config, alertEvent, {
        emailRecipientsOverride
      });

      this.breakerState.set(channelId, { failCount: 0 });
      await this.persistDelivery({
        orgId,
        alertEventId,
        channelId,
        success: true,
        statusCode,
        durationMs: Date.now() - started
      });
      return { success: true };
    } catch (error) {
      const current = this.breakerState.get(channelId) ?? { failCount: 0 };
      const nextFailCount = current.failCount + 1;
      const openUntil = nextFailCount >= 5 ? Date.now() + 5 * 60_000 : undefined;
      this.breakerState.set(channelId, { failCount: nextFailCount, openUntil });

      await this.persistDelivery({
        orgId,
        alertEventId,
        channelId,
        success: false,
        error: error instanceof Error ? error.message : "Delivery failed",
        durationMs: Date.now() - started
      });
      return { success: false };
    }
  }

  async sendTest(channelId: string, orgId: string, severity: AlertSeverity = "HIGH") {
    const eventId = randomUUID();
    await this.prisma.alertEvent.create({
      data: {
        id: eventId,
        orgId,
        type: "TEST_ALERT",
        severity,
        title: "Test alert delivery",
        details: {
          source: "manual-test"
        }
      }
    });
    await this.incidentsService.createIncidentFromAlertEvent(eventId);

    await this.processDeliveryJob({ alertEventId: eventId, channelId, orgId });

    return this.prisma.alertDelivery.findFirst({
      where: { alertEventId: eventId, channelId },
      orderBy: { createdAt: "desc" }
    });
  }

  validateChannelConfig(type: string, config: Record<string, unknown> | undefined): void {
    if (!config || typeof config !== "object") {
      throw new Error("Channel config is required");
    }

    if (type === "WEBHOOK") {
      const url = typeof config.url === "string" ? config.url.trim() : "";
      if (!url || !/^https?:\/\//i.test(url)) {
        throw new Error("Webhook url must be a valid http(s) URL");
      }
      return;
    }

    if (type === "EMAIL") {
      const recipients = Array.isArray(config.to)
        ? config.to.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 3)
        : [];
      if (recipients.length === 0) {
        throw new Error("Email channel requires at least one recipient in config.to");
      }
      return;
    }

    if (type === "SLACK") {
      const channel = typeof config.channel === "string" ? config.channel.trim() : "";
      const channelId = typeof config.channelId === "string" ? config.channelId.trim() : "";
      if (!channel && !channelId) {
        throw new Error("Slack channel requires config.channel or config.channelId");
      }
      return;
    }

    throw new Error("Unsupported channel type");
  }

  private async deliverByChannelType(
    type: string,
    config: Record<string, unknown>,
    alertEvent: {
      id: string;
      orgId: string;
      type: string;
      severity: string;
      title: string;
      details: unknown;
      createdAt: Date;
    },
    options?: { emailRecipientsOverride?: string[] }
  ): Promise<number | undefined> {
    if (type === "WEBHOOK") {
      return this.deliverWebhook(config, alertEvent);
    }

    if (type === "EMAIL") {
      return this.deliverEmail(config, alertEvent, options);
    }

    if (type === "SLACK") {
      return this.deliverSlack(config, alertEvent);
    }

    throw new Error("Unsupported alert channel type");
  }

  private async deliverWebhook(
    config: Record<string, unknown>,
    alertEvent: {
      id: string;
      orgId: string;
      type: string;
      severity: string;
      title: string;
      details: unknown;
      createdAt: Date;
    }
  ): Promise<number | undefined> {
    const url = String(config.url ?? "").trim();
    const secret = typeof config.secret === "string" ? config.secret : "";
    if (!url) {
      throw new Error("Webhook channel missing url");
    }

    const payload = {
      eventId: alertEvent.id,
      orgId: alertEvent.orgId,
      type: alertEvent.type,
      severity: alertEvent.severity,
      title: alertEvent.title,
      details: alertEvent.details,
      createdAt: alertEvent.createdAt.toISOString()
    };

    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Kritviya-Alert": alertEvent.type
    };

    if (secret) {
      headers["X-Kritviya-Signature"] = createHmac("sha256", secret).update(body).digest("hex");
    }

    let lastStatus = 0;
    let lastError = "Webhook delivery failed";

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body
        });
        lastStatus = response.status;
        if (response.ok) {
          return response.status;
        }
        lastError = `Webhook responded with status ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : "Webhook delivery failed";
      }

      if (attempt < 3) {
        await this.delay(150 * 2 ** (attempt - 1));
      }
    }

    throw new Error(lastStatus > 0 ? `WEBHOOK_${lastStatus}` : lastError);
  }

  private async deliverEmail(
    config: Record<string, unknown>,
    alertEvent: {
      id: string;
      orgId: string;
      type: string;
      severity: string;
      title: string;
      details: unknown;
      createdAt: Date;
    },
    options?: { emailRecipientsOverride?: string[] }
  ): Promise<number | undefined> {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error("RESEND_NOT_CONFIGURED");
    }

    const configRecipients = Array.isArray(config.to)
      ? config.to.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 3)
      : [];
    const to =
      options?.emailRecipientsOverride && options.emailRecipientsOverride.length > 0
        ? options.emailRecipientsOverride
        : configRecipients;

    if (to.length === 0) {
      throw new Error("EMAIL_RECIPIENTS_MISSING");
    }

    const from =
      (typeof config.from === "string" && config.from.trim()) ||
      process.env.ALERT_EMAIL_FROM ||
      "alerts@kritviya.local";

    const webBaseUrl = (process.env.WEB_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from,
        to,
        subject: `[Kritviya] ${alertEvent.severity} ${alertEvent.title}`,
        text: `${alertEvent.title}\n\nType: ${alertEvent.type}\nSeverity: ${alertEvent.severity}\n\nView: ${webBaseUrl}/developer?tab=logs#alerts`
      })
    });

    if (!response.ok) {
      throw new Error(`EMAIL_${response.status}`);
    }

    return response.status;
  }

  private async deliverSlack(
    config: Record<string, unknown>,
    alertEvent: {
      id: string;
      orgId: string;
      type: string;
      severity: string;
      title: string;
      details: unknown;
      createdAt: Date;
    }
  ): Promise<number | undefined> {
    const channelId =
      (typeof config.channelId === "string" && config.channelId.trim()) ||
      (typeof config.channel === "string" && config.channel.trim());

    if (!channelId) {
      throw new Error("SLACK_CHANNEL_MISSING");
    }

    const install = await this.prisma.orgAppInstall.findFirst({
      where: {
        orgId: alertEvent.orgId,
        status: "INSTALLED",
        oauthProvider: "slack",
        oauthAccessTokenEncrypted: { not: null },
        app: {
          key: "slack"
        }
      }
    });

    if (!install) {
      throw new Error("SLACK_NOT_CONNECTED");
    }

    const token = await this.oauthService.ensureValidAccessToken(install as OrgAppInstall);
    const webBaseUrl = (process.env.WEB_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
    const severityEmoji =
      alertEvent.severity === "CRITICAL"
        ? ":rotating_light:"
        : alertEvent.severity === "HIGH"
          ? ":warning:"
          : ":information_source:";

    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        channel: channelId,
        text: `${severityEmoji} ${alertEvent.title}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `${severityEmoji} *${alertEvent.title}*\nType: ${alertEvent.type}\nSeverity: ${alertEvent.severity}`
            }
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Open Alerts" },
                url: `${webBaseUrl}/developer?tab=logs#alerts`
              }
            ]
          }
        ]
      })
    });

    const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!response.ok || payload.ok !== true) {
      throw new Error(payload.error ? `SLACK_${payload.error}` : `SLACK_${response.status}`);
    }

    return response.status;
  }

  private isSeverityEligible(eventSeverity: AlertSeverity, minSeverity: AlertSeverity): boolean {
    return SEVERITY_WEIGHT[eventSeverity] >= SEVERITY_WEIGHT[minSeverity];
  }

  private async persistDelivery(input: {
    orgId: string;
    alertEventId: string;
    channelId: string;
    success: boolean;
    statusCode?: number;
    error?: string;
    durationMs?: number;
  }): Promise<void> {
    await this.prisma.alertDelivery
      .create({
        data: {
          orgId: input.orgId,
          alertEventId: input.alertEventId,
          channelId: input.channelId,
          success: input.success,
          statusCode: input.statusCode,
          error: input.error,
          durationMs: input.durationMs
        }
      })
      .catch(() => undefined);
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
