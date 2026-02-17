import { Role } from "@prisma/client";
import { AuthUserContext } from "../src/auth/auth.types";
import { OrgAppsService } from "../src/marketplace/org-apps.service";
import { OAuthProviderFactory } from "../src/oauth/oauth-provider.factory";
import { OAuthService } from "../src/oauth/oauth.service";
import { OAuthStateService } from "../src/oauth/oauth-state.service";
import { decryptOAuthToken, encryptOAuthToken } from "../src/oauth/oauth-token-crypto.util";

describe("OAuth Apps + Install Handshake", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "oauth_test_secret";
    process.env.APP_CONFIG_ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    process.env.WEB_BASE_URL = "http://localhost:3000";
  });

  it("validates signed state and rejects tampered state", () => {
    const stateService = new OAuthStateService();
    const state = stateService.createState({
      orgId: "org-1",
      appKey: "slack",
      provider: "slack",
      userId: "user-1"
    });
    const parsed = stateService.verifyState(state);
    expect(parsed.orgId).toBe("org-1");
    expect(parsed.appKey).toBe("slack");
    expect(parsed.provider).toBe("slack");

    expect(() => stateService.verifyState(`${state}tampered`)).toThrow();
  });

  it("roundtrips OAuth token encryption/decryption", () => {
    const rawToken = "xoxb-secret-token";
    const encrypted = encryptOAuthToken(rawToken);
    expect(encrypted).not.toContain(rawToken);
    expect(decryptOAuthToken(encrypted)).toBe(rawToken);
  });

  it("stores encrypted oauth tokens on callback install flow", async () => {
    const prisma = {
      marketplaceApp: {
        findUnique: jest.fn().mockResolvedValue({
          id: "app-1",
          key: "slack",
          isPublished: true,
          oauthProvider: "slack"
        })
      },
      orgAppInstall: {
        upsert: jest.fn().mockResolvedValue({
          id: "install-1"
        })
      }
    };
    const billing = { assertFeature: jest.fn().mockResolvedValue(undefined) };
    const activity = { log: jest.fn().mockResolvedValue(undefined) };
    const stateService = {
      verifyState: jest.fn().mockReturnValue({
        orgId: "org-1",
        appKey: "slack",
        provider: "slack",
        userId: "user-1"
      })
    };
    const providerFactory = {
      getProvider: jest.fn().mockReturnValue({
        exchangeCode: jest.fn().mockResolvedValue({
          accessToken: "oauth-access-token",
          refreshToken: "oauth-refresh-token",
          expiresAt: new Date("2030-01-01T00:00:00.000Z"),
          scope: "chat:write",
          accountId: "T123"
        })
      })
    };

    const oauthService = new OAuthService(
      prisma as never,
      billing as never,
      activity as never,
      stateService as never,
      providerFactory as never
    );

    const redirectUrl = await oauthService.completeCallback("slack", "code-123", "state-token");
    expect(redirectUrl).toBe("http://localhost:3000/marketplace/slack?connected=true");

    expect(prisma.orgAppInstall.upsert).toHaveBeenCalled();
    const upsertArgs = prisma.orgAppInstall.upsert.mock.calls[0][0];
    expect(upsertArgs.update.oauthAccessTokenEncrypted).toBeDefined();
    expect(upsertArgs.update.oauthAccessTokenEncrypted).not.toContain("oauth-access-token");
    expect(upsertArgs.update.oauthRefreshTokenEncrypted).toBeDefined();
    expect(upsertArgs.update.oauthRefreshTokenEncrypted).not.toContain("oauth-refresh-token");
  });

  it("disconnect clears oauth token fields", async () => {
    const authUser: AuthUserContext = {
      userId: "user-1",
      orgId: "org-1",
      activeOrgId: "org-1",
      role: Role.ADMIN,
      email: "admin@example.com",
      name: "Admin"
    };

    const prisma = {
      marketplaceApp: {
        findUnique: jest.fn().mockResolvedValue({
          id: "app-1",
          key: "slack"
        })
      },
      orgAppInstall: {
        findUnique: jest.fn().mockResolvedValue({
          id: "install-1",
          orgId: "org-1",
          status: "INSTALLED"
        }),
        update: jest.fn().mockResolvedValue({
          id: "install-1",
          status: "INSTALLED"
        })
      }
    };
    const billing = { assertFeature: jest.fn().mockResolvedValue(undefined) };
    const activity = { log: jest.fn().mockResolvedValue(undefined) };
    const webhook = { sendTestTriggerToInstalledApp: jest.fn().mockResolvedValue(undefined) };
    const oauthState = new OAuthStateService();
    const providerFactory = {
      getProvider: jest.fn().mockReturnValue({
        getAuthUrl: jest.fn().mockReturnValue("https://oauth.example.com/start"),
        exchangeCode: jest.fn(),
        refreshToken: jest.fn()
      })
    } as unknown as OAuthProviderFactory;

    const orgAppsService = new OrgAppsService(
      prisma as never,
      billing as never,
      activity as never,
      webhook as never,
      oauthState as never,
      providerFactory as never
    );

    await orgAppsService.disconnectOAuth(authUser, "slack");
    const updateArgs = prisma.orgAppInstall.update.mock.calls[0][0];
    expect(updateArgs.data.oauthAccessTokenEncrypted).toBeNull();
    expect(updateArgs.data.oauthRefreshTokenEncrypted).toBeNull();
    expect(updateArgs.data.oauthExpiresAt).toBeNull();
  });
});
