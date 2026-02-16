import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { ActivityEntityType, OrgAppInstall } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { ActivityLogService } from "../activity-log/activity-log.service";
import { BillingService } from "../billing/billing.service";
import { encryptAppSecret } from "../marketplace/app-secret-crypto.util";
import { PrismaService } from "../prisma/prisma.service";
import { decryptOAuthToken, encryptOAuthToken } from "./oauth-token-crypto.util";
import { OAuthProviderFactory } from "./oauth-provider.factory";
import { OAuthStateService } from "./oauth-state.service";

@Injectable()
export class OAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billingService: BillingService,
    private readonly activityLogService: ActivityLogService,
    private readonly stateService: OAuthStateService,
    private readonly providerFactory: OAuthProviderFactory
  ) {}

  async completeCallback(provider: string, code: string, state: string): Promise<string> {
    if (!code || !state) {
      throw new BadRequestException("Missing OAuth code or state");
    }

    const parsedState = this.stateService.verifyState(state);
    if (parsedState.provider !== provider) {
      throw new BadRequestException("OAuth provider mismatch");
    }

    await this.billingService.assertFeature(parsedState.orgId, "developerPlatformEnabled");

    const app = await this.prisma.marketplaceApp.findUnique({
      where: { key: parsedState.appKey }
    });
    if (!app || !app.isPublished || app.oauthProvider !== provider) {
      throw new NotFoundException("OAuth app not found");
    }

    const oauthProvider = this.providerFactory.getProvider(provider);
    const tokenData = await oauthProvider.exchangeCode(code);

    const generatedSecret = randomBytes(32).toString("hex");
    const generatedSecretHash = createHash("sha256").update(generatedSecret).digest("hex");
    const generatedSecretEncrypted = encryptAppSecret(generatedSecret);

    const install = await this.prisma.orgAppInstall.upsert({
      where: {
        orgId_appId: {
          orgId: parsedState.orgId,
          appId: app.id
        }
      },
      update: {
        status: "INSTALLED",
        oauthProvider: provider,
        oauthAccessTokenEncrypted: encryptOAuthToken(tokenData.accessToken),
        oauthRefreshTokenEncrypted: tokenData.refreshToken
          ? encryptOAuthToken(tokenData.refreshToken)
          : undefined,
        oauthExpiresAt: tokenData.expiresAt,
        oauthScope: tokenData.scope,
        oauthAccountId: tokenData.accountId,
        secretHash: generatedSecretHash,
        secretEncrypted: generatedSecretEncrypted,
        disabledAt: null,
        uninstalledAt: null
      },
      create: {
        orgId: parsedState.orgId,
        appId: app.id,
        status: "INSTALLED",
        installedByUserId: parsedState.userId,
        oauthProvider: provider,
        oauthAccessTokenEncrypted: encryptOAuthToken(tokenData.accessToken),
        oauthRefreshTokenEncrypted: tokenData.refreshToken
          ? encryptOAuthToken(tokenData.refreshToken)
          : undefined,
        oauthExpiresAt: tokenData.expiresAt,
        oauthScope: tokenData.scope,
        oauthAccountId: tokenData.accountId,
        secretHash: generatedSecretHash,
        secretEncrypted: generatedSecretEncrypted
      }
    });

    await this.activityLogService.log({
      orgId: parsedState.orgId,
      actorUserId: parsedState.userId,
      entityType: ActivityEntityType.APP,
      entityId: install.id,
      action: "APP_OAUTH_CONNECTED",
      after: {
        appKey: app.key,
        provider
      }
    });

    const webBaseUrl = process.env.WEB_BASE_URL ?? "http://localhost:3000";
    return `${webBaseUrl}/marketplace/${app.key}?connected=true`;
  }

  getFailureRedirectUrl(state: string | undefined): string {
    const webBaseUrl = process.env.WEB_BASE_URL ?? "http://localhost:3000";
    if (!state) {
      return `${webBaseUrl}/marketplace?error=oauth_callback_failed`;
    }

    try {
      const [encodedPayload] = state.split(".");
      if (!encodedPayload) {
        return `${webBaseUrl}/marketplace?error=oauth_callback_failed`;
      }
      const parsed = JSON.parse(
        Buffer.from(encodedPayload, "base64url").toString("utf8")
      ) as { appKey?: string };
      if (parsed.appKey) {
        return `${webBaseUrl}/marketplace/${parsed.appKey}?connected=false&error=oauth_callback_failed`;
      }
      return `${webBaseUrl}/marketplace?error=oauth_callback_failed`;
    } catch {
      return `${webBaseUrl}/marketplace?error=oauth_callback_failed`;
    }
  }

  async ensureValidAccessToken(install: OrgAppInstall): Promise<string> {
    if (!install.oauthAccessTokenEncrypted || !install.oauthProvider) {
      throw new UnauthorizedException("OAuth is not connected");
    }

    const now = Date.now();
    const expiresAtMs = install.oauthExpiresAt?.getTime();
    const expiringSoon = typeof expiresAtMs === "number" && expiresAtMs <= now + 60_000;
    if (!expiringSoon) {
      return decryptOAuthToken(install.oauthAccessTokenEncrypted);
    }

    if (!install.oauthRefreshTokenEncrypted) {
      throw new UnauthorizedException("OAuth token expired");
    }

    const refreshToken = decryptOAuthToken(install.oauthRefreshTokenEncrypted);
    const provider = this.providerFactory.getProvider(install.oauthProvider);
    const refreshed = await provider.refreshToken(refreshToken);
    const encryptedAccessToken = encryptOAuthToken(refreshed.accessToken);

    await this.prisma.orgAppInstall.update({
      where: { id: install.id },
      data: {
        oauthAccessTokenEncrypted: encryptedAccessToken,
        oauthExpiresAt: refreshed.expiresAt ?? null,
        lastUsedAt: new Date()
      }
    });

    return refreshed.accessToken;
  }
}
