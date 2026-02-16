import { HttpException, HttpStatus, Injectable, NotFoundException } from "@nestjs/common";
import { ActivityEntityType } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { ActivityLogService } from "../activity-log/activity-log.service";
import { AuthUserContext } from "../auth/auth.types";
import { BillableFeatureKey } from "../billing/billing.types";
import { BillingService } from "../billing/billing.service";
import { getActiveOrgId } from "../common/auth-org";
import { PaginationQueryDto } from "../common/dto/pagination-query.dto";
import { toPaginatedResponse } from "../common/dto/paginated-response.dto";
import { WebhookService } from "../org-webhooks/webhook.service";
import { OAuthProviderFactory } from "../oauth/oauth-provider.factory";
import { OAuthStateService } from "../oauth/oauth-state.service";
import { PrismaService } from "../prisma/prisma.service";
import { decryptAppConfig, encryptAppConfig } from "./app-config-crypto.util";
import { encryptAppSecret } from "./app-secret-crypto.util";
import { UpdateOrgAppConfigDto } from "./dto/update-org-app-config.dto";

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function toSecret(): string {
  return randomBytes(32).toString("hex");
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

@Injectable()
export class OrgAppsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billingService: BillingService,
    private readonly activityLogService: ActivityLogService,
    private readonly webhookService: WebhookService,
    private readonly oauthStateService: OAuthStateService,
    private readonly oauthProviderFactory: OAuthProviderFactory
  ) {}

  async install(authUser: AuthUserContext, appKey: string) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "developerPlatformEnabled");

    const app = await this.prisma.marketplaceApp.findUnique({ where: { key: appKey } });
    if (!app || !app.isPublished) {
      throw new NotFoundException("Marketplace app not found");
    }

    const existing = await this.prisma.orgAppInstall.findUnique({
      where: { orgId_appId: { orgId, appId: app.id } }
    });

    if (existing && existing.status === "INSTALLED") {
      if (!existing.secretEncrypted || !existing.secretHash) {
        const appSecret = toSecret();
        await this.prisma.orgAppInstall.update({
          where: { id: existing.id },
          data: {
            secretHash: hashSecret(appSecret),
            secretEncrypted: encryptAppSecret(appSecret)
          }
        });
        return {
          id: existing.id,
          appKey: app.key,
          status: existing.status,
          installedAt: existing.installedAt,
          configVersion: existing.configVersion,
          appSecret
        };
      }

      return {
        id: existing.id,
        appKey: app.key,
        status: existing.status,
        installedAt: existing.installedAt,
        configVersion: existing.configVersion,
        appSecret: null
      };
    }

    const appSecret = toSecret();
    const secretHash = hashSecret(appSecret);
    const secretEncrypted = encryptAppSecret(appSecret);

    const install = await this.prisma.orgAppInstall.upsert({
      where: { orgId_appId: { orgId, appId: app.id } },
      update: {
        status: "INSTALLED",
        installedByUserId: authUser.userId,
        installedAt: new Date(),
        disabledAt: null,
        uninstalledAt: null,
        secretHash,
        secretEncrypted
      },
      create: {
        orgId,
        appId: app.id,
        status: "INSTALLED",
        installedByUserId: authUser.userId,
        secretHash,
        secretEncrypted
      }
    });

    await this.activityLogService.log({
      orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.APP,
      entityId: install.id,
      action: "APP_INSTALLED",
      after: { appKey: app.key, status: install.status }
    });

    return {
      id: install.id,
      appKey: app.key,
      status: install.status,
      installedAt: install.installedAt,
      configVersion: install.configVersion,
      appSecret
    };
  }

  async getOAuthStartUrl(authUser: AuthUserContext, appKey: string): Promise<string> {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "developerPlatformEnabled");

    const app = await this.prisma.marketplaceApp.findUnique({ where: { key: appKey } });
    if (!app || !app.isPublished) {
      throw new NotFoundException("Marketplace app not found");
    }
    if (!app.oauthProvider) {
      throw new HttpException("OAuth not supported for this app", HttpStatus.CONFLICT);
    }

    const state = this.oauthStateService.createState({
      orgId,
      appKey,
      provider: app.oauthProvider,
      userId: authUser.userId
    });
    const provider = this.oauthProviderFactory.getProvider(app.oauthProvider);
    return provider.getAuthUrl(state);
  }

  async list(authUser: AuthUserContext) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "developerPlatformEnabled");

    const installs = await this.prisma.orgAppInstall.findMany({
      where: {
        orgId,
        status: { not: "UNINSTALLED" }
      },
      include: {
        app: true
      },
      orderBy: [{ installedAt: "desc" }]
    });

    return installs.map((install) => ({
      id: install.id,
      appId: install.appId,
      appKey: install.app.key,
      appName: install.app.name,
      appDescription: install.app.description,
      appCategory: install.app.category,
      appIconUrl: install.app.iconUrl,
      scopes: parseStringArray(install.app.scopes),
      webhookEvents: parseStringArray(install.app.webhookEvents),
      status: install.status,
      installedAt: install.installedAt,
      disabledAt: install.disabledAt,
      uninstalledAt: install.uninstalledAt,
      lastUsedAt: install.lastUsedAt,
      configVersion: install.configVersion,
      oauthProvider: install.oauthProvider ?? install.app.oauthProvider,
      oauthConnected: Boolean(install.oauthAccessTokenEncrypted),
      webhookUrl: this.extractWebhookUrl(install.configEncrypted)
    }));
  }

  async sendTestTrigger(authUser: AuthUserContext, appKey: string, eventName: string) {
    const install = await this.getInstallOrFail(authUser, appKey);
    if (install.status !== "INSTALLED") {
      throw new HttpException("App is not installed", HttpStatus.CONFLICT);
    }
    if (!install.configEncrypted) {
      throw new HttpException("App webhook URL is not configured", HttpStatus.CONFLICT);
    }

    const supportedEvents = parseStringArray(install.app.webhookEvents);
    if (!supportedEvents.includes(eventName)) {
      throw new HttpException("Event not supported by this app", HttpStatus.BAD_REQUEST);
    }

    const orgId = getActiveOrgId({ user: authUser });
    const payload = {
      type: "APP_TEST_TRIGGER",
      appKey,
      eventName,
      orgId,
      timestamp: new Date().toISOString()
    };

    await this.webhookService.sendTestTriggerToInstalledApp(orgId, appKey, eventName, payload);

    return {
      success: true,
      appKey,
      eventName
    };
  }

  async listDeliveries(authUser: AuthUserContext, appKey: string, query: PaginationQueryDto) {
    const install = await this.getInstallOrFail(authUser, appKey);
    const orgId = getActiveOrgId({ user: authUser });
    const skip = (query.page - 1) * query.pageSize;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.webhookDelivery.findMany({
        where: {
          orgId,
          endpointId: install.id
        },
        orderBy: [{ createdAt: "desc" }],
        skip,
        take: query.pageSize
      }),
      this.prisma.webhookDelivery.count({
        where: {
          orgId,
          endpointId: install.id
        }
      })
    ]);

    return toPaginatedResponse(items, query.page, query.pageSize, total);
  }

  async replayDelivery(authUser: AuthUserContext, appKey: string, deliveryId: string) {
    const install = await this.getInstallOrFail(authUser, appKey);
    const orgId = getActiveOrgId({ user: authUser });

    await this.webhookService.retryInstalledAppDelivery(orgId, install.id, deliveryId);

    return { success: true };
  }

  async listCommandLogs(authUser: AuthUserContext, appKey: string, query: PaginationQueryDto) {
    const install = await this.getInstallOrFail(authUser, appKey);
    const orgId = getActiveOrgId({ user: authUser });
    const skip = (query.page - 1) * query.pageSize;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.appCommandLog.findMany({
        where: {
          orgId,
          appInstallId: install.id
        },
        orderBy: [{ createdAt: "desc" }],
        skip,
        take: query.pageSize
      }),
      this.prisma.appCommandLog.count({
        where: {
          orgId,
          appInstallId: install.id
        }
      })
    ]);

    return toPaginatedResponse(items, query.page, query.pageSize, total);
  }

  async updateConfig(authUser: AuthUserContext, appKey: string, dto: UpdateOrgAppConfigDto) {
    const install = await this.getInstallOrFail(authUser, appKey);
    if (install.status === "UNINSTALLED") {
      throw new NotFoundException("App install not found");
    }
    if (install.status === "DISABLED") {
      throw new HttpException("App is disabled", HttpStatus.CONFLICT);
    }

    const configEncrypted = encryptAppConfig(dto.config);
    const updated = await this.prisma.orgAppInstall.update({
      where: { id: install.id },
      data: {
        configEncrypted,
        configVersion: { increment: 1 }
      }
    });

    await this.activityLogService.log({
      orgId: install.orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.APP,
      entityId: install.id,
      action: "APP_CONFIG_UPDATED",
      after: { appKey, configVersion: updated.configVersion }
    });

    return {
      id: updated.id,
      appKey,
      status: updated.status,
      configVersion: updated.configVersion
    };
  }

  async rotateSecret(authUser: AuthUserContext, appKey: string) {
    const install = await this.getInstallOrFail(authUser, appKey);
    if (install.status === "UNINSTALLED") {
      throw new NotFoundException("App install not found");
    }

    const appSecret = toSecret();
    await this.prisma.orgAppInstall.update({
      where: { id: install.id },
      data: {
        secretHash: hashSecret(appSecret),
        secretEncrypted: encryptAppSecret(appSecret)
      }
    });

    await this.activityLogService.log({
      orgId: install.orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.APP,
      entityId: install.id,
      action: "APP_SECRET_ROTATED",
      after: { appKey }
    });

    return {
      id: install.id,
      appKey,
      appSecret
    };
  }

  async disable(authUser: AuthUserContext, appKey: string) {
    const install = await this.getInstallOrFail(authUser, appKey);
    const updated = await this.prisma.orgAppInstall.update({
      where: { id: install.id },
      data: {
        status: "DISABLED",
        disabledAt: new Date()
      }
    });

    await this.activityLogService.log({
      orgId: install.orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.APP,
      entityId: install.id,
      action: "APP_DISABLED",
      after: { appKey, status: updated.status }
    });

    return {
      id: updated.id,
      appKey,
      status: updated.status,
      disabledAt: updated.disabledAt
    };
  }

  async enable(authUser: AuthUserContext, appKey: string) {
    const install = await this.getInstallOrFail(authUser, appKey);
    const updated = await this.prisma.orgAppInstall.update({
      where: { id: install.id },
      data: {
        status: "INSTALLED",
        disabledAt: null
      }
    });

    await this.activityLogService.log({
      orgId: install.orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.APP,
      entityId: install.id,
      action: "APP_ENABLED",
      after: { appKey, status: updated.status }
    });

    return {
      id: updated.id,
      appKey,
      status: updated.status
    };
  }

  async uninstall(authUser: AuthUserContext, appKey: string) {
    const install = await this.getInstallOrFail(authUser, appKey);
    const updated = await this.prisma.orgAppInstall.update({
      where: { id: install.id },
      data: {
        status: "UNINSTALLED",
        uninstalledAt: new Date(),
        configEncrypted: null,
        secretHash: null,
        secretEncrypted: null,
        oauthAccessTokenEncrypted: null,
        oauthRefreshTokenEncrypted: null,
        oauthExpiresAt: null,
        oauthScope: null,
        oauthAccountId: null
      }
    });

    await this.activityLogService.log({
      orgId: install.orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.APP,
      entityId: install.id,
      action: "APP_UNINSTALLED",
      after: { appKey, status: updated.status }
    });

    return {
      id: updated.id,
      appKey,
      status: updated.status,
      uninstalledAt: updated.uninstalledAt
    };
  }

  async disconnectOAuth(authUser: AuthUserContext, appKey: string) {
    const install = await this.getInstallOrFail(authUser, appKey, "developerPlatformEnabled");
    const updated = await this.prisma.orgAppInstall.update({
      where: { id: install.id },
      data: {
        oauthAccessTokenEncrypted: null,
        oauthRefreshTokenEncrypted: null,
        oauthExpiresAt: null,
        oauthScope: null,
        oauthAccountId: null
      }
    });

    await this.activityLogService.log({
      orgId: install.orgId,
      actorUserId: authUser.userId,
      entityType: ActivityEntityType.APP,
      entityId: install.id,
      action: "APP_OAUTH_DISCONNECTED",
      after: { appKey, status: updated.status }
    });

    return {
      id: updated.id,
      appKey,
      status: updated.status
    };
  }

  private async getInstallOrFail(
    authUser: AuthUserContext,
    appKey: string,
    requiredFeature: BillableFeatureKey = "developerPlatformEnabled"
  ) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, requiredFeature);

    const app = await this.prisma.marketplaceApp.findUnique({ where: { key: appKey } });
    if (!app) {
      throw new NotFoundException("Marketplace app not found");
    }

    const install = await this.prisma.orgAppInstall.findUnique({
      where: {
        orgId_appId: {
          orgId,
          appId: app.id
        }
      },
      include: {
        app: {
          select: {
            webhookEvents: true
          }
        }
      }
    });

    if (!install) {
      throw new NotFoundException("App install not found");
    }

    return install;
  }

  private extractWebhookUrl(configEncrypted: string | null): string | null {
    if (!configEncrypted) {
      return null;
    }
    try {
      const config = decryptAppConfig(configEncrypted);
      if (typeof config.webhookUrl !== "string") {
        return null;
      }
      const value = config.webhookUrl.trim();
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }
}
