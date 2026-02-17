import { BadRequestException, ConflictException, Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHmac, randomBytes } from "node:crypto";
import { encryptAppConfig, decryptAppConfig } from "../marketplace/app-config-crypto.util";
import { PrismaService } from "../prisma/prisma.service";
import { SubscribeStatusDto } from "./dto/subscribe-status.dto";

const COMPONENT_KEYS = ["api", "web", "db", "webhooks", "ai", "billing"] as const;
type ComponentKey = (typeof COMPONENT_KEYS)[number];
type StatusNotificationType = "CREATED" | "UPDATED" | "RESOLVED";

interface PublicIncidentNotification {
  id: string;
  orgId: string;
  title: string;
  severity: string;
  publicSummary: string | null;
  publicSlug: string | null;
  publicComponentKeys: Prisma.JsonValue | null;
  isPublic: boolean;
}

const STATUS_WEIGHT: Record<string, number> = {
  OPERATIONAL: 0,
  DEGRADED: 1,
  PARTIAL_OUTAGE: 2,
  MAJOR_OUTAGE: 3
};
const STATUS_MAX_SUBSCRIBERS_DEFAULT = 1000;

@Injectable()
export class StatusService {
  private readonly logger = new Logger(StatusService.name);
  private readonly cache = new Map<string, { expiresAt: number; payload: unknown }>();

  constructor(private readonly prisma: PrismaService) {}

  async subscribe(dto: SubscribeStatusDto, sourceIp: string) {
    const email = dto.email?.trim().toLowerCase();
    const webhookUrl = dto.webhookUrl?.trim();
    if (!email && !webhookUrl) {
      throw new BadRequestException("Either email or webhookUrl is required");
    }

    const orgId = process.env.STATUS_PUBLIC_ORG_ID || null;
    const maxSubscribers = Number(process.env.STATUS_MAX_SUBSCRIBERS || STATUS_MAX_SUBSCRIBERS_DEFAULT);
    const currentCount = await this.prisma.statusSubscriber.count({
      where: orgId ? { orgId } : {}
    });
    if (currentCount >= maxSubscribers) {
      throw new ConflictException("Status subscriber limit reached");
    }

    const validatedComponentKeys = await this.normalizeAndValidateComponentKeys(dto.componentKeys ?? []);
    const confirmationToken = randomBytes(24).toString("hex");
    const unsubToken = randomBytes(24).toString("hex");
    const webhookSecret = webhookUrl ? randomBytes(32).toString("hex") : null;

    await this.prisma.$transaction(async (tx) => {
      const created = await tx.statusSubscriber.create({
        data: {
          orgId,
          email: email ?? null,
          webhookUrl: webhookUrl ?? null,
          secretEncrypted: webhookSecret ? encryptAppConfig({ secret: webhookSecret }) : null,
          isConfirmed: Boolean(webhookUrl),
          confirmationToken,
          unsubToken
        }
      });

      if (validatedComponentKeys.length === 0) {
        await tx.statusSubscription.create({
          data: {
            subscriberId: created.id,
            componentKey: null
          }
        });
      } else {
        await tx.statusSubscription.createMany({
          data: validatedComponentKeys.map((componentKey) => ({
            subscriberId: created.id,
            componentKey
          }))
        });
      }
    });

    if (email) {
      await this.sendConfirmationEmail(email, confirmationToken, unsubToken, sourceIp);
    }

    return {
      success: true,
      message:
        "Subscription request received. If email was provided, check your inbox to confirm your subscription."
    };
  }

  async confirm(token: string): Promise<boolean> {
    if (!token.trim()) {
      return false;
    }
    const updated = await this.prisma.statusSubscriber.updateMany({
      where: {
        confirmationToken: token.trim(),
        isConfirmed: false
      },
      data: {
        isConfirmed: true
      }
    });
    return updated.count > 0;
  }

  async unsubscribe(token: string): Promise<boolean> {
    if (!token.trim()) {
      return false;
    }
    const subscriber = await this.prisma.statusSubscriber.findUnique({
      where: { unsubToken: token.trim() },
      select: { id: true }
    });
    if (!subscriber) {
      return false;
    }
    await this.prisma.$transaction([
      this.prisma.statusSubscription.deleteMany({ where: { subscriberId: subscriber.id } }),
      this.prisma.statusSubscriber.delete({ where: { id: subscriber.id } })
    ]);
    return true;
  }

  async notifyPublicIncidentChange(
    incident: PublicIncidentNotification,
    type: StatusNotificationType
  ): Promise<void> {
    if (!incident.isPublic) {
      return;
    }

    const incidentComponentKeys = this.normalizeComponentKeys(incident.publicComponentKeys);
    const subscribers = await this.prisma.statusSubscriber.findMany({
      where: {
        isConfirmed: true,
        OR: [{ orgId: null }, { orgId: incident.orgId }]
      },
      include: {
        subscriptions: true
      }
    });

    for (const subscriber of subscribers) {
      if (!this.shouldNotifySubscriber(subscriber.subscriptions, incidentComponentKeys)) {
        continue;
      }

      const alreadyNotified = await this.prisma.statusNotificationLog.findFirst({
        where: {
          subscriberId: subscriber.id,
          incidentId: incident.id,
          type,
          success: true
        },
        select: { id: true }
      });
      if (alreadyNotified) {
        continue;
      }

      const payload = this.buildWebhookPayload(incident, type);
      if (subscriber.email) {
        await this.deliverStatusEmail(subscriber.id, incident.id, type, subscriber.email, payload);
      }
      if (subscriber.webhookUrl) {
        const secret = this.readWebhookSecret(subscriber.secretEncrypted);
        await this.deliverStatusWebhook(
          subscriber.id,
          incident.id,
          type,
          subscriber.webhookUrl,
          payload,
          secret
        );
      }
    }
  }

  async seedDefaultComponents(orgId: string | null = null): Promise<void> {
    const defs: Array<{ key: ComponentKey; name: string; description: string }> = [
      { key: "api", name: "API", description: "Core API request handling" },
      { key: "web", name: "Web App", description: "Dashboard web frontend availability" },
      { key: "db", name: "Database", description: "Primary Postgres read/write path" },
      { key: "webhooks", name: "Webhooks", description: "Outbound webhook delivery pipeline" },
      { key: "ai", name: "AI", description: "AI insight/action and LLM services" },
      { key: "billing", name: "Billing", description: "Subscription and payment integrations" }
    ];

    for (const def of defs) {
      await this.prisma.statusComponent.upsert({
        where: { key: def.key },
        update: { name: def.name, description: def.description, ...(orgId ? { orgId } : {}) },
        create: {
          key: def.key,
          name: def.name,
          description: def.description,
          orgId
        }
      });
    }
  }

  async runUptimeScan(): Promise<{ checked: number }> {
    await this.seedDefaultComponents();

    const components = await this.prisma.statusComponent.findMany({ orderBy: { key: "asc" } });
    for (const component of components) {
      const check = await this.checkComponent(component.key as ComponentKey);
      await this.prisma.uptimeCheck.create({
        data: {
          componentKey: component.key,
          ok: check.ok,
          statusCode: check.statusCode,
          latencyMs: check.latencyMs
        }
      });

      await this.recomputeStatus(component.key, check.forcedStatus);
    }

    this.cache.clear();
    return { checked: components.length };
  }

  async getPublicStatus() {
    const cacheKey = "public:status";
    const cached = this.getCached(cacheKey);
    if (cached) {
      return cached;
    }

    await this.seedDefaultComponents();

    const components = await this.prisma.statusComponent.findMany({ orderBy: { key: "asc" } });
    const componentPayload = await Promise.all(
      components.map(async (component) => {
        const [uptime24h, uptime7d] = await Promise.all([
          this.computeUptime(component.key, 24),
          this.computeUptime(component.key, 24 * 7)
        ]);
        return {
          key: component.key,
          name: component.name,
          description: component.description,
          status: component.status,
          updatedAt: component.updatedAt,
          uptime24h,
          uptime7d
        };
      })
    );

    const incidents = await this.prisma.incident.findMany({
      where: {
        isPublic: true,
        status: { in: ["OPEN", "ACKNOWLEDGED"] }
      },
      orderBy: [{ updatedAt: "desc" }],
      take: 20,
      select: {
        id: true,
        title: true,
        severity: true,
        status: true,
        publicSummary: true,
        publicSlug: true,
        publicUpdates: true,
        updatedAt: true,
        publicComponentKeys: true
      }
    });

    const overallStatus = componentPayload.reduce((current, component) => {
      return STATUS_WEIGHT[component.status] > STATUS_WEIGHT[current] ? component.status : current;
    }, "OPERATIONAL");

    const payload = {
      overallStatus,
      components: componentPayload,
      activeIncidents: incidents.map((incident) => ({
        id: incident.id,
        slug: incident.publicSlug,
        title: incident.title,
        severity: incident.severity,
        status: incident.status,
        summary: incident.publicSummary,
        updatedAt: incident.updatedAt,
        updates: this.normalizePublicUpdates(incident.publicUpdates),
        componentKeys: this.normalizeComponentKeys(incident.publicComponentKeys)
      }))
    };

    this.setCached(cacheKey, payload, 60_000);
    return payload;
  }

  async listPublicIncidents() {
    const cacheKey = "public:incidents";
    const cached = this.getCached(cacheKey);
    if (cached) {
      return cached;
    }

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const incidents = await this.prisma.incident.findMany({
      where: {
        isPublic: true,
        createdAt: { gte: since }
      },
      orderBy: [{ createdAt: "desc" }],
      select: {
        id: true,
        title: true,
        severity: true,
        status: true,
        publicSummary: true,
        publicSlug: true,
        publicUpdates: true,
        createdAt: true,
        updatedAt: true,
        publicComponentKeys: true
      }
    });

    const payload = incidents.map((incident) => ({
      id: incident.id,
      slug: incident.publicSlug,
      title: incident.title,
      severity: incident.severity,
      status: incident.status,
      summary: incident.publicSummary,
      updates: this.normalizePublicUpdates(incident.publicUpdates),
      componentKeys: this.normalizeComponentKeys(incident.publicComponentKeys),
      createdAt: incident.createdAt,
      updatedAt: incident.updatedAt
    }));

    this.setCached(cacheKey, payload, 60_000);
    return payload;
  }

  async getPublicIncidentBySlug(slug: string) {
    const incident = await this.prisma.incident.findFirst({
      where: { publicSlug: slug, isPublic: true },
      select: {
        id: true,
        title: true,
        severity: true,
        status: true,
        publicSummary: true,
        publicSlug: true,
        publicUpdates: true,
        publicComponentKeys: true,
        createdAt: true,
        updatedAt: true
      }
    });

    if (!incident) {
      return null;
    }

    return {
      id: incident.id,
      slug: incident.publicSlug,
      title: incident.title,
      severity: incident.severity,
      status: incident.status,
      summary: incident.publicSummary,
      updates: this.normalizePublicUpdates(incident.publicUpdates),
      componentKeys: this.normalizeComponentKeys(incident.publicComponentKeys),
      createdAt: incident.createdAt,
      updatedAt: incident.updatedAt
    };
  }

  private async recomputeStatus(componentKey: string, forcedStatus?: string): Promise<void> {
    const recent = await this.prisma.uptimeCheck.findMany({
      where: { componentKey },
      orderBy: [{ checkedAt: "desc" }],
      take: 5
    });

    const failures = recent.filter((entry) => !entry.ok).length;
    let status = "OPERATIONAL";
    if (failures >= 5) {
      status = "MAJOR_OUTAGE";
    } else if (failures >= 3) {
      status = "DEGRADED";
    }

    if (forcedStatus && STATUS_WEIGHT[forcedStatus] > STATUS_WEIGHT[status]) {
      status = forcedStatus;
    }

    const criticalIncident = await this.prisma.incident.findFirst({
      where: {
        isPublic: true,
        severity: "CRITICAL",
        status: { in: ["OPEN", "ACKNOWLEDGED"] },
        publicComponentKeys: {
          array_contains: componentKey
        }
      },
      select: { id: true }
    });

    if (criticalIncident) {
      status = "MAJOR_OUTAGE";
    }

    await this.prisma.statusComponent.update({
      where: { key: componentKey },
      data: { status }
    });
  }

  private async checkComponent(
    componentKey: ComponentKey
  ): Promise<{ ok: boolean; statusCode?: number; latencyMs?: number; forcedStatus?: string }> {
    if (componentKey === "db") {
      const started = Date.now();
      try {
        await this.prisma.$queryRaw`SELECT 1`;
        return { ok: true, latencyMs: Date.now() - started };
      } catch {
        return { ok: false, latencyMs: Date.now() - started };
      }
    }

    if (componentKey === "webhooks") {
      const recentSpike = await this.prisma.alertEvent.findFirst({
        where: {
          type: "WEBHOOK_FAILURE_SPIKE",
          createdAt: { gte: new Date(Date.now() - 15 * 60_000) }
        },
        select: { id: true }
      });
      return { ok: !recentSpike };
    }

    if (componentKey === "ai") {
      const enabled = (process.env.FEATURE_AI_ENABLED ?? "true").toLowerCase() === "true";
      const llmEnabled = (process.env.LLM_ENABLED ?? "false").toLowerCase() === "true";
      if (!enabled || !llmEnabled) {
        return { ok: true, forcedStatus: "DEGRADED" };
      }
      return { ok: true };
    }

    if (componentKey === "billing") {
      const recentFailure = await this.prisma.alertEvent.findFirst({
        where: {
          type: "WEBHOOK_FAILURE_SPIKE",
          createdAt: { gte: new Date(Date.now() - 15 * 60_000) },
          details: { path: ["provider"], equals: "razorpay" }
        },
        select: { id: true }
      });
      return { ok: !recentFailure };
    }

    const url = this.componentUrl(componentKey);
    if (!url) {
      return { ok: false };
    }

    const started = Date.now();
    try {
      const response = await fetch(url, { method: "GET" });
      return {
        ok: response.ok,
        statusCode: response.status,
        latencyMs: Date.now() - started
      };
    } catch {
      return { ok: false, latencyMs: Date.now() - started };
    }
  }

  private componentUrl(componentKey: ComponentKey): string | null {
    const apiBase = (process.env.API_BASE_URL ?? "http://localhost:4000").replace(/\/$/, "");
    const webBase = (process.env.WEB_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
    if (componentKey === "api") {
      return `${apiBase}/health`;
    }
    if (componentKey === "web") {
      return `${webBase}/login`;
    }
    return null;
  }

  private async normalizeAndValidateComponentKeys(componentKeys: string[]): Promise<string[]> {
    if (componentKeys.length === 0) {
      return [];
    }
    const normalized = Array.from(
      new Set(
        componentKeys
          .map((entry) => entry.trim().toLowerCase())
          .filter((entry) => entry.length > 0)
      )
    );
    const existing = await this.prisma.statusComponent.findMany({
      where: { key: { in: normalized } },
      select: { key: true }
    });
    const existingSet = new Set(existing.map((entry) => entry.key));
    return normalized.filter((entry) => existingSet.has(entry));
  }

  private shouldNotifySubscriber(
    subscriptions: Array<{ componentKey: string | null }>,
    incidentComponentKeys: string[]
  ): boolean {
    if (subscriptions.length === 0) {
      return true;
    }
    if (subscriptions.some((subscription) => subscription.componentKey === null)) {
      return true;
    }
    if (incidentComponentKeys.length === 0) {
      return false;
    }
    const subscriptionSet = new Set(
      subscriptions
        .map((subscription) => subscription.componentKey?.toLowerCase())
        .filter((entry): entry is string => Boolean(entry))
    );
    return incidentComponentKeys.some((componentKey) => subscriptionSet.has(componentKey));
  }

  private buildWebhookPayload(incident: PublicIncidentNotification, type: StatusNotificationType) {
    const eventType =
      type === "CREATED"
        ? "INCIDENT_CREATED"
        : type === "RESOLVED"
          ? "INCIDENT_RESOLVED"
          : "INCIDENT_UPDATED";
    const webBase = (process.env.WEB_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
    return {
      type: eventType,
      incidentId: incident.id,
      title: incident.title,
      severity: incident.severity,
      summary: incident.publicSummary,
      url: incident.publicSlug ? `${webBase}/status/incidents/${incident.publicSlug}` : `${webBase}/status`,
      timestamp: new Date().toISOString()
    };
  }

  private readWebhookSecret(secretEncrypted: string | null): string {
    if (!secretEncrypted) {
      return "";
    }
    try {
      const config = decryptAppConfig(secretEncrypted);
      return typeof config.secret === "string" ? config.secret : "";
    } catch {
      return "";
    }
  }

  private async deliverStatusEmail(
    subscriberId: string,
    incidentId: string,
    type: StatusNotificationType,
    email: string,
    payload: ReturnType<StatusService["buildWebhookPayload"]>
  ): Promise<void> {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      await this.logStatusNotificationAttempt({
        subscriberId,
        incidentId,
        type,
        success: false,
        error: "RESEND_NOT_CONFIGURED"
      });
      return;
    }

    const apiBase = (process.env.API_BASE_URL ?? "http://localhost:4000").replace(/\/$/, "");
    const subscriber = await this.prisma.statusSubscriber.findUnique({
      where: { id: subscriberId },
      select: { unsubToken: true }
    });
    const unsubscribeUrl = subscriber ? `${apiBase}/status/unsubscribe?token=${subscriber.unsubToken}` : null;

    const subject = `[Status] Incident Update: ${payload.title}`;
    const text = `${payload.title}
Severity: ${payload.severity}
Update type: ${payload.type}
Summary: ${payload.summary ?? "No summary provided."}
Status page: ${payload.url}
${unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : ""}`;

    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: process.env.ALERT_EMAIL_FROM || "status@kritviya.local",
          to: [email],
          subject,
          text
        })
      });

      if (!response.ok) {
        await this.logStatusNotificationAttempt({
          subscriberId,
          incidentId,
          type,
          success: false,
          error: `EMAIL_${response.status}`
        });
        return;
      }

      await this.logStatusNotificationAttempt({
        subscriberId,
        incidentId,
        type,
        success: true
      });
    } catch (error) {
      await this.logStatusNotificationAttempt({
        subscriberId,
        incidentId,
        type,
        success: false,
        error: error instanceof Error ? error.message : "EMAIL_DELIVERY_FAILED"
      });
    }
  }

  private async deliverStatusWebhook(
    subscriberId: string,
    incidentId: string,
    type: StatusNotificationType,
    webhookUrl: string,
    payload: ReturnType<StatusService["buildWebhookPayload"]>,
    secret: string
  ): Promise<void> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (secret) {
      headers["X-Kritviya-Signature"] = createHmac("sha256", secret).update(body).digest("hex");
    }

    let delivered = false;
    let lastError = "WEBHOOK_DELIVERY_FAILED";

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(webhookUrl, {
          method: "POST",
          headers,
          body
        });
        if (response.ok) {
          await this.logStatusNotificationAttempt({
            subscriberId,
            incidentId,
            type,
            success: true
          });
          delivered = true;
          break;
        }
        lastError = `WEBHOOK_${response.status}`;
        await this.logStatusNotificationAttempt({
          subscriberId,
          incidentId,
          type,
          success: false,
          error: lastError
        });
      } catch (error) {
        lastError = error instanceof Error ? error.message : "WEBHOOK_DELIVERY_FAILED";
        await this.logStatusNotificationAttempt({
          subscriberId,
          incidentId,
          type,
          success: false,
          error: lastError
        });
      }

      if (attempt < 3) {
        await this.delay(200 * 2 ** (attempt - 1));
      }
    }

    if (!delivered) {
      this.logger.warn(`Status webhook delivery failed subscriber=${subscriberId} incident=${incidentId}: ${lastError}`);
    }
  }

  private async logStatusNotificationAttempt(input: {
    subscriberId: string;
    incidentId: string;
    type: StatusNotificationType;
    success: boolean;
    error?: string;
  }): Promise<void> {
    await this.prisma.statusNotificationLog.create({
      data: {
        subscriberId: input.subscriberId,
        incidentId: input.incidentId,
        type: input.type,
        success: input.success,
        error: input.error ?? null
      }
    });
  }

  private async sendConfirmationEmail(
    email: string,
    confirmationToken: string,
    unsubToken: string,
    sourceIp: string
  ): Promise<void> {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      return;
    }
    const apiBase = (process.env.API_BASE_URL ?? "http://localhost:4000").replace(/\/$/, "");
    const confirmUrl = `${apiBase}/status/confirm?token=${confirmationToken}`;
    const unsubscribeUrl = `${apiBase}/status/unsubscribe?token=${unsubToken}`;
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: process.env.ALERT_EMAIL_FROM || "status@kritviya.local",
          to: [email],
          subject: "[Status] Confirm your Kritviya status subscription",
          text: `Confirm your status subscription: ${confirmUrl}\n\nIf you did not request this, ignore this email.\nUnsubscribe link: ${unsubscribeUrl}\nSource IP: ${sourceIp}`
        })
      });
    } catch (error) {
      this.logger.warn(
        `Failed to send status confirmation email to ${email}: ${
          error instanceof Error ? error.message : "unknown"
        }`
      );
    }
  }

  private async delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private async computeUptime(componentKey: string, hours: number): Promise<number> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const checks = await this.prisma.uptimeCheck.findMany({
      where: {
        componentKey,
        checkedAt: { gte: since }
      },
      select: { ok: true }
    });

    if (checks.length === 0) {
      return 100;
    }

    const okCount = checks.filter((entry) => entry.ok).length;
    return Math.round((okCount / checks.length) * 1000) / 10;
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

  private normalizeComponentKeys(value: Prisma.JsonValue | null): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((entry) => String(entry).trim().toLowerCase())
      .filter((entry) => COMPONENT_KEYS.includes(entry as ComponentKey));
  }

  private getCached<T>(key: string): T | null {
    const hit = this.cache.get(key);
    if (!hit) {
      return null;
    }
    if (hit.expiresAt < Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return hit.payload as T;
  }

  private setCached(key: string, payload: unknown, ttlMs: number): void {
    this.cache.set(key, {
      payload,
      expiresAt: Date.now() + ttlMs
    });
  }
}
