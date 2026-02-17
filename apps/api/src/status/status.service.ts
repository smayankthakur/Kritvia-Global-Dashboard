import { Injectable, Logger } from "@nestjs/common";
import { Prisma, StatusComponent } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

const COMPONENT_KEYS = ["api", "web", "db", "webhooks", "ai", "billing"] as const;
type ComponentKey = (typeof COMPONENT_KEYS)[number];

const STATUS_WEIGHT: Record<string, number> = {
  OPERATIONAL: 0,
  DEGRADED: 1,
  PARTIAL_OUTAGE: 2,
  MAJOR_OUTAGE: 3
};

@Injectable()
export class StatusService {
  private readonly logger = new Logger(StatusService.name);
  private readonly cache = new Map<string, { expiresAt: number; payload: unknown }>();

  constructor(private readonly prisma: PrismaService) {}

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
