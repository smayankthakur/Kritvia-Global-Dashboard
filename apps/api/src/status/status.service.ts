
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { AuthUserContext } from "../auth/auth.types";
import { getActiveOrgId } from "../common/auth-org";
import { decryptAppConfig, encryptAppConfig } from "../marketplace/app-config-crypto.util";
import { PrismaService } from "../prisma/prisma.service";
import { SubscribeStatusDto } from "./dto/subscribe-status.dto";
import { UpdateStatusSettingsDto } from "./dto/update-status-settings.dto";

const COMPONENT_KEYS = ["api", "web", "db", "webhooks", "ai", "billing"] as const;
type ComponentKey = (typeof COMPONENT_KEYS)[number];
type StatusNotificationType = "CREATED" | "UPDATED" | "RESOLVED";
type StatusVisibility = "PUBLIC" | "PRIVATE_TOKEN" | "PRIVATE_SSO";

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
const STATUS_AUTH_COOKIE_NAME = "kritviya_status_session";
const MAGIC_LINK_TTL_MINUTES = 15;

@Injectable()
export class StatusService {
  private readonly logger = new Logger(StatusService.name);
  private readonly cache = new Map<string, { expiresAt: number; payload: unknown }>();
  private readonly magicLinkRateLimitByIp = new Map<string, number[]>();
  private readonly magicLinkRateLimitByEmail = new Map<string, number[]>();

  constructor(private readonly prisma: PrismaService) {}

  async resolveDomain(host: string): Promise<{ orgSlug: string | null }> {
    const normalized = this.normalizeHost(host);
    if (!normalized) {
      return { orgSlug: null };
    }
    const org = await this.prisma.org.findFirst({
      where: {
        customStatusDomain: normalized,
        customDomainVerifiedAt: { not: null },
        statusEnabled: true
      },
      select: { slug: true }
    });
    return { orgSlug: org?.slug ?? null };
  }

  async getStatusSettings(authUser: AuthUserContext) {
    const orgId = getActiveOrgId({ user: authUser });
    const org = await this.prisma.org.findUnique({
      where: { id: orgId },
      select: {
        slug: true,
        statusEnabled: true,
        statusName: true,
        statusLogoUrl: true,
        statusAccentColor: true,
        statusFooterText: true,
        statusVisibility: true,
        statusAllowedEmailDomains: true,
        statusSessionTtlMinutes: true,
        customStatusDomain: true,
        customDomainVerifiedAt: true
      }
    });
    if (!org) {
      throw new NotFoundException("Organization not found");
    }
    return {
      enabled: org.statusEnabled,
      slug: org.slug,
      name: org.statusName,
      logoUrl: org.statusLogoUrl,
      accentColor: org.statusAccentColor,
      footerText: org.statusFooterText,
      visibility: org.statusVisibility,
      statusAllowedEmailDomains: this.normalizeAllowedDomains(org.statusAllowedEmailDomains),
      statusSessionTtlMinutes: org.statusSessionTtlMinutes,
      customStatusDomain: org.customStatusDomain,
      customDomainVerifiedAt: org.customDomainVerifiedAt
    };
  }

  async updateStatusSettings(authUser: AuthUserContext, dto: UpdateStatusSettingsDto) {
    const orgId = getActiveOrgId({ user: authUser });

    if (dto.slug) {
      const slugConflict = await this.prisma.org.findFirst({
        where: { slug: dto.slug, NOT: { id: orgId } },
        select: { id: true }
      });
      if (slugConflict) {
        throw new ConflictException("Status slug is already in use");
      }
    }

    const data: Prisma.OrgUpdateInput = {
      ...(dto.enabled !== undefined ? { statusEnabled: dto.enabled } : {}),
      ...(dto.slug !== undefined ? { slug: dto.slug } : {}),
      ...(dto.name !== undefined ? { statusName: dto.name } : {}),
      ...(dto.logoUrl !== undefined ? { statusLogoUrl: dto.logoUrl } : {}),
      ...(dto.accentColor !== undefined ? { statusAccentColor: dto.accentColor } : {}),
      ...(dto.footerText !== undefined ? { statusFooterText: dto.footerText } : {}),
      ...(dto.visibility !== undefined ? { statusVisibility: dto.visibility } : {}),
      ...(dto.statusAllowedEmailDomains !== undefined
        ? { statusAllowedEmailDomains: dto.statusAllowedEmailDomains as Prisma.InputJsonValue }
        : {}),
      ...(dto.statusSessionTtlMinutes !== undefined
        ? { statusSessionTtlMinutes: dto.statusSessionTtlMinutes }
        : {})
    };
    if (dto.accessToken !== undefined) {
      data.statusAccessTokenHash =
        dto.accessToken.trim().length > 0 ? this.hashPrivateToken(dto.accessToken) : null;
    }

    const org = await this.prisma.org.update({
      where: { id: orgId },
      data,
      select: {
        slug: true,
        statusEnabled: true,
        statusName: true,
        statusLogoUrl: true,
        statusAccentColor: true,
        statusFooterText: true,
        statusVisibility: true,
        statusAllowedEmailDomains: true,
        statusSessionTtlMinutes: true,
        customStatusDomain: true,
        customDomainVerifiedAt: true
      }
    });

    if (dto.enabled === true) {
      await this.seedDefaultComponents(orgId);
    }
    this.clearOrgCache(org.slug, orgId);

    return {
      enabled: org.statusEnabled,
      slug: org.slug,
      name: org.statusName,
      logoUrl: org.statusLogoUrl,
      accentColor: org.statusAccentColor,
      footerText: org.statusFooterText,
      visibility: org.statusVisibility,
      statusAllowedEmailDomains: this.normalizeAllowedDomains(org.statusAllowedEmailDomains),
      statusSessionTtlMinutes: org.statusSessionTtlMinutes,
      customStatusDomain: org.customStatusDomain,
      customDomainVerifiedAt: org.customDomainVerifiedAt
    };
  }

  async requestCustomDomain(authUser: AuthUserContext, domain: string) {
    const orgId = getActiveOrgId({ user: authUser });
    const normalized = this.normalizeDomain(domain);

    const conflict = await this.prisma.org.findFirst({
      where: {
        customStatusDomain: normalized,
        NOT: { id: orgId }
      },
      select: { id: true }
    });
    if (conflict) {
      throw new ConflictException("Domain is already used by another organization");
    }

    const verifyToken = randomBytes(24).toString("hex");
    await this.prisma.org.update({
      where: { id: orgId },
      data: {
        customStatusDomain: normalized,
        customDomainVerifyToken: verifyToken,
        customDomainVerifiedAt: null
      }
    });

    return {
      domain: normalized,
      txtRecord: {
        name: `_kritviya-status.${normalized}`,
        value: verifyToken
      }
    };
  }

  async verifyCustomDomain(authUser: AuthUserContext) {
    const orgId = getActiveOrgId({ user: authUser });
    const org = await this.prisma.org.findUnique({
      where: { id: orgId },
      select: { customStatusDomain: true, customDomainVerifyToken: true, slug: true }
    });
    if (!org?.customStatusDomain || !org.customDomainVerifyToken) {
      throw new BadRequestException("No custom domain verification request found");
    }

    const host = `_kritviya-status.${org.customStatusDomain}`;
    const records = await resolveTxt(host).catch(() => [] as string[][]);
    const tokens = records.map((row) => row.join("").trim());
    if (!tokens.includes(org.customDomainVerifyToken)) {
      throw new BadRequestException("Domain verification TXT record not found");
    }

    const verifiedAt = new Date();
    await this.prisma.org.update({
      where: { id: orgId },
      data: { customDomainVerifiedAt: verifiedAt }
    });
    this.clearOrgCache(org.slug, orgId);
    return { domain: org.customStatusDomain, verifiedAt: verifiedAt.toISOString() };
  }

  async requestMagicLink(orgSlug: string, email: string, sourceIp: string) {
    const normalizedEmail = email.trim().toLowerCase();
    const org = await this.prisma.org.findFirst({
      where: { slug: orgSlug.trim().toLowerCase(), statusEnabled: true, statusVisibility: "PRIVATE_SSO" },
      select: {
        id: true,
        slug: true,
        statusAllowedEmailDomains: true
      }
    });
    if (!org) {
      throw new BadRequestException("Status SSO is not enabled for this org");
    }

    const emailDomain = normalizedEmail.split("@")[1]?.toLowerCase() ?? "";
    const allowedDomains = this.normalizeAllowedDomains(org.statusAllowedEmailDomains);
    if (allowedDomains.length > 0 && !allowedDomains.includes(emailDomain)) {
      throw new BadRequestException("Email domain is not allowed for this status page");
    }

    this.enforceMagicLinkRateLimit(`ip:${sourceIp}`, this.magicLinkRateLimitByIp);
    this.enforceMagicLinkRateLimit(`email:${org.id}:${normalizedEmail}`, this.magicLinkRateLimitByEmail);

    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = this.sha256(rawToken);
    const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MINUTES * 60_000);
    await this.prisma.statusAuthToken.create({
      data: {
        orgId: org.id,
        email: normalizedEmail,
        tokenHash,
        expiresAt
      }
    });

    await this.sendMagicLinkEmail(org.slug, normalizedEmail, rawToken);
    return {
      success: true,
      message: "If your domain is allowed, you will receive a login link shortly."
    };
  }

  async verifyMagicLink(orgSlug: string, email: string, token: string) {
    const normalizedSlug = orgSlug.trim().toLowerCase();
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedSlug || !normalizedEmail || !token.trim()) {
      throw new BadRequestException("orgSlug, email and token are required");
    }

    const org = await this.prisma.org.findFirst({
      where: { slug: normalizedSlug, statusEnabled: true, statusVisibility: "PRIVATE_SSO" },
      select: {
        id: true,
        slug: true,
        statusAllowedEmailDomains: true,
        statusSessionTtlMinutes: true
      }
    });
    if (!org) {
      throw new UnauthorizedException({ code: "STATUS_AUTH_REQUIRED", message: "Status authentication required." });
    }

    const emailDomain = normalizedEmail.split("@")[1]?.toLowerCase() ?? "";
    const allowedDomains = this.normalizeAllowedDomains(org.statusAllowedEmailDomains);
    if (allowedDomains.length > 0 && !allowedDomains.includes(emailDomain)) {
      throw new UnauthorizedException({ code: "STATUS_AUTH_REQUIRED", message: "Status authentication required." });
    }

    const tokenHash = this.sha256(token.trim());
    const authToken = await this.prisma.statusAuthToken.findFirst({
      where: {
        orgId: org.id,
        email: normalizedEmail,
        tokenHash,
        usedAt: null,
        expiresAt: { gt: new Date() }
      },
      orderBy: { createdAt: "desc" }
    });
    if (!authToken) {
      throw new UnauthorizedException({ code: "STATUS_AUTH_REQUIRED", message: "Status authentication required." });
    }

    await this.prisma.statusAuthToken.update({
      where: { id: authToken.id },
      data: { usedAt: new Date() }
    });

    const ttlMinutes = Math.max(30, org.statusSessionTtlMinutes);
    const expiresAt = Date.now() + ttlMinutes * 60_000;
    const value = this.signStatusSession({
      orgId: org.id,
      email: normalizedEmail,
      exp: expiresAt
    });

    return {
      cookie: {
        name: STATUS_AUTH_COOKIE_NAME,
        value,
        options: {
          httpOnly: true,
          secure: this.shouldUseSecureStatusCookie(),
          sameSite: "lax" as const,
          path: "/",
          maxAge: ttlMinutes * 60 * 1000
        }
      }
    };
  }

  getClearedStatusSessionCookie() {
    return {
      name: STATUS_AUTH_COOKIE_NAME,
      value: "",
      options: {
        httpOnly: true,
        secure: this.shouldUseSecureStatusCookie(),
        sameSite: "lax" as const,
        path: "/",
        maxAge: 0
      }
    };
  }

  async subscribeByOrgSlug(orgSlug: string, dto: SubscribeStatusDto, sourceIp: string, privateToken?: string) {
    const org = await this.getEnabledOrgBySlug(orgSlug);
    this.assertPrivateAccess(org, privateToken);
    return this.subscribeForOrg(org.id, org.slug, dto, sourceIp);
  }

  async confirmByOrgSlug(orgSlug: string, token: string): Promise<boolean> {
    const org = await this.getEnabledOrgBySlug(orgSlug);
    return this.confirmForOrg(org.id, token);
  }

  async unsubscribeByOrgSlug(orgSlug: string, token: string): Promise<boolean> {
    const org = await this.getEnabledOrgBySlug(orgSlug);
    return this.unsubscribeForOrg(org.id, token);
  }

  async getPublicStatusByOrgSlug(orgSlug: string, privateToken?: string, statusSession?: string) {
    const org = await this.getEnabledOrgBySlug(orgSlug);
    this.assertPrivateAccess(org, privateToken, statusSession);

    const cacheKey = `public:status:${org.id}`;
    const cached = this.getCached(cacheKey);
    if (cached) {
      return cached;
    }

    await this.seedDefaultComponents(org.id);
    const components = await this.prisma.statusComponent.findMany({
      where: { orgId: org.id },
      orderBy: { key: "asc" }
    });
    const componentPayload = await Promise.all(
      components.map(async (component) => ({
        key: component.key,
        name: component.name,
        description: component.description,
        status: component.status,
        updatedAt: component.updatedAt,
        uptime24h: await this.computeUptime(org.id, component.key, 24),
        uptime7d: await this.computeUptime(org.id, component.key, 24 * 7)
      }))
    );

    const incidents = await this.prisma.incident.findMany({
      where: {
        orgId: org.id,
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

    const overallStatus = componentPayload.reduce(
      (current, component) =>
        STATUS_WEIGHT[component.status] > STATUS_WEIGHT[current] ? component.status : current,
      "OPERATIONAL"
    );

    const payload = {
      org: {
        slug: org.slug,
        name: org.statusName ?? `${org.name} Status`,
        logoUrl: org.statusLogoUrl,
        accentColor: org.statusAccentColor,
        footerText: org.statusFooterText,
        visibility: org.statusVisibility
      },
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

  async listPublicIncidentsByOrgSlug(orgSlug: string, privateToken?: string, statusSession?: string) {
    const org = await this.getEnabledOrgBySlug(orgSlug);
    this.assertPrivateAccess(org, privateToken, statusSession);

    const cacheKey = `public:incidents:${org.id}`;
    const cached = this.getCached(cacheKey);
    if (cached) {
      return cached;
    }

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const incidents = await this.prisma.incident.findMany({
      where: {
        orgId: org.id,
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

  async getPublicIncidentByOrgSlugAndSlug(
    orgSlug: string,
    slug: string,
    privateToken?: string,
    statusSession?: string
  ) {
    const org = await this.getEnabledOrgBySlug(orgSlug);
    this.assertPrivateAccess(org, privateToken, statusSession);

    const incident = await this.prisma.incident.findFirst({
      where: { orgId: org.id, publicSlug: slug, isPublic: true },
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

  async subscribeLegacy(dto: SubscribeStatusDto, sourceIp: string) {
    const org = await this.getLegacyOrg();
    return this.subscribeForOrg(org.id, org.slug, dto, sourceIp);
  }

  async confirmLegacy(token: string): Promise<boolean> {
    const org = await this.getLegacyOrg();
    return this.confirmForOrg(org.id, token);
  }

  async unsubscribeLegacy(token: string): Promise<boolean> {
    const org = await this.getLegacyOrg();
    return this.unsubscribeForOrg(org.id, token);
  }

  async getLegacyPublicStatus() {
    const org = await this.getLegacyOrg();
    return this.getPublicStatusByOrgSlug(org.slug);
  }

  async listLegacyPublicIncidents() {
    const org = await this.getLegacyOrg();
    return this.listPublicIncidentsByOrgSlug(org.slug);
  }

  async getLegacyPublicIncidentBySlug(slug: string) {
    const org = await this.getLegacyOrg();
    return this.getPublicIncidentByOrgSlugAndSlug(org.slug, slug);
  }

  async notifyPublicIncidentChange(
    incident: PublicIncidentNotification,
    type: StatusNotificationType
  ): Promise<void> {
    if (!incident.isPublic) {
      return;
    }
    const org = await this.prisma.org.findUnique({
      where: { id: incident.orgId },
      select: { slug: true }
    });
    if (!org?.slug) {
      return;
    }

    const incidentComponentKeys = this.normalizeComponentKeys(incident.publicComponentKeys);
    const subscribers = await this.prisma.statusSubscriber.findMany({
      where: { orgId: incident.orgId, isConfirmed: true },
      include: { subscriptions: true }
    });

    for (const subscriber of subscribers) {
      if (!this.shouldNotifySubscriber(subscriber.subscriptions, incidentComponentKeys)) {
        continue;
      }
      const alreadyNotified = await this.prisma.statusNotificationLog.findFirst({
        where: {
          orgId: incident.orgId,
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

      const payload = this.buildWebhookPayload(incident, type, org.slug);
      if (subscriber.email) {
        await this.deliverStatusEmail(incident.orgId, subscriber.id, incident.id, type, subscriber.email, payload);
      }
      if (subscriber.webhookUrl) {
        await this.deliverStatusWebhook(
          incident.orgId,
          subscriber.id,
          incident.id,
          type,
          subscriber.webhookUrl,
          payload,
          this.readWebhookSecret(subscriber.secretEncrypted)
        );
      }
    }
    this.clearOrgCache(org.slug, incident.orgId);
  }

  async seedDefaultComponents(orgId: string): Promise<void> {
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
        where: { orgId_key: { orgId, key: def.key } },
        update: { name: def.name, description: def.description },
        create: { orgId, key: def.key, name: def.name, description: def.description }
      });
    }
  }

  async runUptimeScan(): Promise<{ checked: number; processedOrgs: number }> {
    const orgs = await this.prisma.org.findMany({
      where: {
        OR: [
          { statusEnabled: true },
          { statusComponents: { some: {} } }
        ]
      },
      select: { id: true },
      orderBy: { createdAt: "asc" }
    });
    let checked = 0;
    for (const org of orgs) {
      await this.seedDefaultComponents(org.id);
      const components = await this.prisma.statusComponent.findMany({
        where: { orgId: org.id },
        orderBy: { key: "asc" }
      });
      for (const component of components) {
        const check = await this.checkComponent(org.id, component.key as ComponentKey);
        await this.prisma.uptimeCheck.create({
          data: {
            orgId: org.id,
            componentKey: component.key,
            ok: check.ok,
            statusCode: check.statusCode,
            latencyMs: check.latencyMs
          }
        });
        await this.recomputeStatus(org.id, component.key, check.forcedStatus);
        checked += 1;
      }
      this.clearOrgCache(undefined, org.id);
    }
    return { checked, processedOrgs: orgs.length };
  }

  private async subscribeForOrg(orgId: string, orgSlug: string, dto: SubscribeStatusDto, sourceIp: string) {
    const email = dto.email?.trim().toLowerCase();
    const webhookUrl = dto.webhookUrl?.trim();
    if (!email && !webhookUrl) {
      throw new BadRequestException("Either email or webhookUrl is required");
    }

    const maxSubscribers = Number(process.env.STATUS_MAX_SUBSCRIBERS || STATUS_MAX_SUBSCRIBERS_DEFAULT);
    const currentCount = await this.prisma.statusSubscriber.count({ where: { orgId } });
    if (currentCount >= maxSubscribers) {
      throw new ConflictException("Status subscriber limit reached");
    }

    const componentKeys = await this.normalizeAndValidateComponentKeys(orgId, dto.componentKeys ?? []);
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
      if (componentKeys.length === 0) {
        await tx.statusSubscription.create({
          data: { orgId, subscriberId: created.id, componentKey: null }
        });
      } else {
        await tx.statusSubscription.createMany({
          data: componentKeys.map((key) => ({
            orgId,
            subscriberId: created.id,
            componentKey: key
          }))
        });
      }
    });

    if (email) {
      await this.sendConfirmationEmail(email, orgSlug, confirmationToken, unsubToken, sourceIp);
    }
    return {
      success: true,
      message:
        "Subscription request received. If email was provided, check your inbox to confirm your subscription."
    };
  }

  private async confirmForOrg(orgId: string, token: string): Promise<boolean> {
    if (!token.trim()) {
      return false;
    }
    const updated = await this.prisma.statusSubscriber.updateMany({
      where: { orgId, confirmationToken: token.trim(), isConfirmed: false },
      data: { isConfirmed: true }
    });
    return updated.count > 0;
  }

  private async unsubscribeForOrg(orgId: string, token: string): Promise<boolean> {
    if (!token.trim()) {
      return false;
    }
    const subscriber = await this.prisma.statusSubscriber.findFirst({
      where: { orgId, unsubToken: token.trim() },
      select: { id: true }
    });
    if (!subscriber) {
      return false;
    }
    await this.prisma.$transaction([
      this.prisma.statusSubscription.deleteMany({ where: { orgId, subscriberId: subscriber.id } }),
      this.prisma.statusSubscriber.delete({ where: { id: subscriber.id } })
    ]);
    return true;
  }

  private async getEnabledOrgBySlug(orgSlug: string) {
    const normalized = orgSlug.trim().toLowerCase();
    if (!normalized) {
      throw new NotFoundException("Status page not found");
    }
    const org = await this.prisma.org.findFirst({
      where: { slug: normalized, statusEnabled: true },
      select: {
        id: true,
        name: true,
        slug: true,
        statusName: true,
        statusLogoUrl: true,
        statusAccentColor: true,
        statusFooterText: true,
        statusVisibility: true,
        statusAllowedEmailDomains: true,
        statusSessionTtlMinutes: true,
        statusAccessTokenHash: true
      }
    });
    if (!org) {
      throw new NotFoundException("Status page not found");
    }
    return org;
  }

  private async getLegacyOrg() {
    const envSlug = process.env.STATUS_PUBLIC_ORG_SLUG?.trim().toLowerCase();
    if (envSlug) {
      const orgBySlug = await this.prisma.org.findFirst({
        where: { slug: envSlug, statusEnabled: true },
        select: { id: true, slug: true }
      });
      if (orgBySlug) {
        return orgBySlug;
      }
    }
    const org = await this.prisma.org.findFirst({
      where: { statusEnabled: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, slug: true }
    });
    if (!org) {
      throw new NotFoundException("No enabled status page found");
    }
    return org;
  }

  private assertPrivateAccess(
    org: {
      id: string;
      statusVisibility: string;
      statusAccessTokenHash: string | null;
      statusAllowedEmailDomains?: Prisma.JsonValue | null;
    },
    token?: string,
    statusSession?: string
  ) {
    const visibility = (org.statusVisibility as StatusVisibility) ?? "PUBLIC";
    if (visibility === "PUBLIC") {
      return;
    }
    if (visibility === "PRIVATE_TOKEN") {
      if (!token || !org.statusAccessTokenHash || !this.verifyPrivateToken(token, org.statusAccessTokenHash)) {
        throw new NotFoundException("Status page not found");
      }
      return;
    }

    const session = this.verifyStatusSession(statusSession);
    if (!session || session.orgId !== org.id) {
      throw new UnauthorizedException({
        code: "STATUS_AUTH_REQUIRED",
        message: "Status authentication required."
      });
    }
    const allowedDomains = this.normalizeAllowedDomains(org.statusAllowedEmailDomains ?? null);
    if (allowedDomains.length > 0) {
      const emailDomain = session.email.split("@")[1]?.toLowerCase() ?? "";
      if (!allowedDomains.includes(emailDomain)) {
        throw new UnauthorizedException({
          code: "STATUS_AUTH_REQUIRED",
          message: "Status authentication required."
        });
      }
    }
  }

  private hashPrivateToken(token: string): string {
    const salt = randomBytes(16).toString("hex");
    const digest = createHash("sha256").update(`${salt}:${token}`).digest("hex");
    return `sha256:${salt}:${digest}`;
  }

  private verifyPrivateToken(token: string, hash: string): boolean {
    const [algo, salt, expected] = hash.split(":");
    if (algo !== "sha256" || !salt || !expected) {
      return false;
    }
    const actual = createHash("sha256").update(`${salt}:${token}`).digest("hex");
    const a = Buffer.from(actual, "hex");
    const b = Buffer.from(expected, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private normalizeDomain(domain: string): string {
    const normalized = domain.trim().toLowerCase();
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(normalized)) {
      throw new BadRequestException("Invalid domain format");
    }
    return normalized;
  }

  private normalizeHost(hostHeader: string): string | null {
    const raw = hostHeader.trim().toLowerCase();
    if (!raw) {
      return null;
    }
    return raw.includes(":") ? (raw.split(":")[0] ?? null) : raw;
  }

  private async recomputeStatus(orgId: string, componentKey: string, forcedStatus?: string): Promise<void> {
    const recent = await this.prisma.uptimeCheck.findMany({
      where: { orgId, componentKey },
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
        orgId,
        isPublic: true,
        severity: "CRITICAL",
        status: { in: ["OPEN", "ACKNOWLEDGED"] },
        publicComponentKeys: { array_contains: componentKey }
      },
      select: { id: true }
    });
    if (criticalIncident) {
      status = "MAJOR_OUTAGE";
    }

    await this.prisma.statusComponent.update({
      where: { orgId_key: { orgId, key: componentKey } },
      data: { status }
    });
  }

  private async checkComponent(
    orgId: string,
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
      const event = await this.prisma.alertEvent.findFirst({
        where: {
          orgId,
          type: "WEBHOOK_FAILURE_SPIKE",
          createdAt: { gte: new Date(Date.now() - 15 * 60_000) }
        },
        select: { id: true }
      });
      return { ok: !event };
    }
    if (componentKey === "ai") {
      const aiEnabled = (process.env.FEATURE_AI_ENABLED ?? "true").toLowerCase() === "true";
      const llmEnabled = (process.env.LLM_ENABLED ?? "false").toLowerCase() === "true";
      if (!aiEnabled || !llmEnabled) {
        return { ok: true, forcedStatus: "DEGRADED" };
      }
      return { ok: true };
    }
    if (componentKey === "billing") {
      const failure = await this.prisma.alertEvent.findFirst({
        where: {
          orgId,
          type: "WEBHOOK_FAILURE_SPIKE",
          createdAt: { gte: new Date(Date.now() - 15 * 60_000) },
          details: { path: ["provider"], equals: "razorpay" }
        },
        select: { id: true }
      });
      return { ok: !failure };
    }

    const url = this.componentUrl(componentKey);
    if (!url) {
      return { ok: false };
    }
    const started = Date.now();
    try {
      const response = await fetch(url, { method: "GET" });
      return { ok: response.ok, statusCode: response.status, latencyMs: Date.now() - started };
    } catch {
      return { ok: false, latencyMs: Date.now() - started };
    }
  }

  private componentUrl(componentKey: ComponentKey): string | null {
    const apiBase = (process.env.PUBLIC_API_BASE_URL ?? process.env.API_BASE_URL ?? "http://localhost:4000").replace(
      /\/$/,
      ""
    );
    const webBase = (process.env.PUBLIC_WEB_BASE_URL ?? process.env.WEB_BASE_URL ?? "http://localhost:3000").replace(
      /\/$/,
      ""
    );
    if (componentKey === "api") {
      return `${apiBase}/health`;
    }
    if (componentKey === "web") {
      return `${webBase}/`;
    }
    return null;
  }

  private async normalizeAndValidateComponentKeys(orgId: string, componentKeys: string[]): Promise<string[]> {
    if (componentKeys.length === 0) {
      return [];
    }
    const normalized = Array.from(
      new Set(componentKeys.map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0))
    );
    const existing = await this.prisma.statusComponent.findMany({
      where: { orgId, key: { in: normalized } },
      select: { key: true }
    });
    const existingSet = new Set(existing.map((entry) => entry.key));
    return normalized.filter((entry) => existingSet.has(entry));
  }

  private shouldNotifySubscriber(
    subscriptions: Array<{ componentKey: string | null }>,
    incidentComponentKeys: string[]
  ): boolean {
    if (subscriptions.length === 0 || subscriptions.some((subscription) => subscription.componentKey === null)) {
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

  private buildWebhookPayload(incident: PublicIncidentNotification, type: StatusNotificationType, orgSlug: string) {
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
      url: incident.publicSlug
        ? `${webBase}/status/o/${orgSlug}/incidents/${incident.publicSlug}`
        : `${webBase}/status/o/${orgSlug}`,
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
    orgId: string,
    subscriberId: string,
    incidentId: string,
    type: StatusNotificationType,
    email: string,
    payload: ReturnType<StatusService["buildWebhookPayload"]>
  ): Promise<void> {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      await this.logStatusNotificationAttempt({ orgId, subscriberId, incidentId, type, success: false, error: "RESEND_NOT_CONFIGURED" });
      return;
    }

    const apiBase = (process.env.API_BASE_URL ?? "http://localhost:4000").replace(/\/$/, "");
    const subscriber = await this.prisma.statusSubscriber.findUnique({
      where: { id: subscriberId },
      include: { org: { select: { slug: true } } }
    });
    const unsubscribeUrl = subscriber
      ? `${apiBase}/status/o/${subscriber.org.slug}/unsubscribe?token=${subscriber.unsubToken}`
      : null;

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
          orgId,
          subscriberId,
          incidentId,
          type,
          success: false,
          error: `EMAIL_${response.status}`
        });
        return;
      }
      await this.logStatusNotificationAttempt({ orgId, subscriberId, incidentId, type, success: true });
    } catch (error) {
      await this.logStatusNotificationAttempt({
        orgId,
        subscriberId,
        incidentId,
        type,
        success: false,
        error: error instanceof Error ? error.message : "EMAIL_DELIVERY_FAILED"
      });
    }
  }

  private async deliverStatusWebhook(
    orgId: string,
    subscriberId: string,
    incidentId: string,
    type: StatusNotificationType,
    webhookUrl: string,
    payload: ReturnType<StatusService["buildWebhookPayload"]>,
    secret: string
  ): Promise<void> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (secret) {
      headers["X-Kritviya-Signature"] = createHmac("sha256", secret).update(body).digest("hex");
    }

    let delivered = false;
    let lastError = "WEBHOOK_DELIVERY_FAILED";

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(webhookUrl, { method: "POST", headers, body });
        if (response.ok) {
          await this.logStatusNotificationAttempt({ orgId, subscriberId, incidentId, type, success: true });
          delivered = true;
          break;
        }
        lastError = `WEBHOOK_${response.status}`;
        await this.logStatusNotificationAttempt({
          orgId,
          subscriberId,
          incidentId,
          type,
          success: false,
          error: lastError
        });
      } catch (error) {
        lastError = error instanceof Error ? error.message : "WEBHOOK_DELIVERY_FAILED";
        await this.logStatusNotificationAttempt({
          orgId,
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
    orgId: string;
    subscriberId: string;
    incidentId: string;
    type: StatusNotificationType;
    success: boolean;
    error?: string;
  }): Promise<void> {
    await this.prisma.statusNotificationLog.create({
      data: {
        orgId: input.orgId,
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
    orgSlug: string,
    confirmationToken: string,
    unsubToken: string,
    sourceIp: string
  ): Promise<void> {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      return;
    }
    const apiBase = (process.env.API_BASE_URL ?? "http://localhost:4000").replace(/\/$/, "");
    const confirmUrl = `${apiBase}/status/o/${orgSlug}/confirm?token=${confirmationToken}`;
    const unsubscribeUrl = `${apiBase}/status/o/${orgSlug}/unsubscribe?token=${unsubToken}`;
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
      this.logger.warn(`Failed to send status confirmation email to ${email}: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }

  private async delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private async computeUptime(orgId: string, componentKey: string, hours: number): Promise<number> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const checks = await this.prisma.uptimeCheck.findMany({
      where: { orgId, componentKey, checkedAt: { gte: since } },
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
        return ts && message ? { ts, message } : null;
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

  private normalizeAllowedDomains(value: Prisma.JsonValue | null): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return Array.from(
      new Set(
        value
          .map((entry) => String(entry).trim().toLowerCase())
          .filter((entry) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(entry))
      )
    );
  }

  private enforceMagicLinkRateLimit(key: string, bucket: Map<string, number[]>) {
    const now = Date.now();
    const windowStart = now - 60 * 60 * 1000;
    const existing = bucket.get(key) ?? [];
    const inWindow = existing.filter((timestamp) => timestamp >= windowStart);
    if (inWindow.length >= 3) {
      throw new HttpException("Too many login link requests. Try again later.", HttpStatus.TOO_MANY_REQUESTS);
    }
    inWindow.push(now);
    bucket.set(key, inWindow);
  }

  private shouldUseSecureStatusCookie(): boolean {
    const explicit = process.env.COOKIE_SECURE;
    if (explicit !== undefined) {
      return explicit.toLowerCase() === "true" || explicit === "1";
    }
    return (process.env.NODE_ENV ?? "development") === "production";
  }

  private sha256(input: string): string {
    return createHash("sha256").update(input).digest("hex");
  }

  private signStatusSession(payload: { orgId: string; email: string; exp: number }): string {
    const secret = process.env.STATUS_SESSION_SECRET;
    if (!secret) {
      throw new BadRequestException("STATUS_SESSION_SECRET is not configured");
    }
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  private verifyStatusSession(token?: string): { orgId: string; email: string; exp: number } | null {
    if (!token || !token.includes(".")) {
      return null;
    }
    const [encoded, signature] = token.split(".");
    if (!encoded || !signature) {
      return null;
    }
    const secret = process.env.STATUS_SESSION_SECRET;
    if (!secret) {
      return null;
    }
    const expected = createHmac("sha256", secret).update(encoded).digest("base64url");
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return null;
    }
    try {
      const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
        orgId?: string;
        email?: string;
        exp?: number;
      };
      if (!payload.orgId || !payload.email || !payload.exp || Date.now() >= payload.exp) {
        return null;
      }
      return { orgId: payload.orgId, email: payload.email.toLowerCase(), exp: payload.exp };
    } catch {
      return null;
    }
  }

  private async sendMagicLinkEmail(orgSlug: string, email: string, rawToken: string): Promise<void> {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      return;
    }
    const statusBase = (process.env.STATUS_BASE_URL ?? process.env.WEB_BASE_URL ?? "http://localhost:3000").replace(
      /\/$/,
      ""
    );
    const callbackUrl = `${statusBase}/status/o/${orgSlug}/login/callback?token=${encodeURIComponent(
      rawToken
    )}&email=${encodeURIComponent(email)}`;

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
          subject: "[Kritviya Status] Your secure sign-in link",
          text: `Use this one-time secure link to access the status page:\n${callbackUrl}\n\nThis link expires in ${MAGIC_LINK_TTL_MINUTES} minutes.`
        })
      });
    } catch (error) {
      this.logger.warn(
        `Failed to send status magic link email to ${email}: ${
          error instanceof Error ? error.message : "unknown"
        }`
      );
    }
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
    this.cache.set(key, { payload, expiresAt: Date.now() + ttlMs });
  }

  private clearOrgCache(orgSlug?: string, orgId?: string): void {
    for (const key of Array.from(this.cache.keys())) {
      if (orgId && key.endsWith(`:${orgId}`)) {
        this.cache.delete(key);
        continue;
      }
      if (orgSlug && key.includes(`:${orgSlug}`)) {
        this.cache.delete(key);
      }
    }
  }
}
