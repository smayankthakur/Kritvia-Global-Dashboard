import { BadGatewayException, InternalServerErrorException } from "@nestjs/common";
import { OAuthExchangeResult, OAuthProvider, OAuthRefreshResult } from "../oauth-provider.interface";

interface SlackTokenResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  team?: { id?: string };
  authed_user?: { id?: string };
}

export class SlackOAuthProvider implements OAuthProvider {
  getAuthUrl(state: string): string {
    const clientId = process.env.SLACK_CLIENT_ID;
    const redirectUri = process.env.SLACK_REDIRECT_URI;
    if (!clientId || !redirectUri) {
      throw new InternalServerErrorException("Slack OAuth is not configured");
    }

    const scope = process.env.SLACK_OAUTH_SCOPES ?? "chat:write";
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("scope", scope);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    return url.toString();
  }

  async exchangeCode(code: string): Promise<OAuthExchangeResult> {
    const clientId = process.env.SLACK_CLIENT_ID;
    const clientSecret = process.env.SLACK_CLIENT_SECRET;
    const redirectUri = process.env.SLACK_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) {
      throw new InternalServerErrorException("Slack OAuth is not configured");
    }

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri
    });

    const response = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const data = (await response.json()) as SlackTokenResponse;
    if (!response.ok || !data.ok || !data.access_token) {
      throw new BadGatewayException("Slack OAuth token exchange failed");
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : undefined,
      scope: data.scope,
      accountId: data.team?.id ?? data.authed_user?.id
    };
  }

  async refreshToken(refreshToken: string): Promise<OAuthRefreshResult> {
    const clientId = process.env.SLACK_CLIENT_ID;
    const clientSecret = process.env.SLACK_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new InternalServerErrorException("Slack OAuth is not configured");
    }

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken
    });

    const response = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const data = (await response.json()) as SlackTokenResponse;
    if (!response.ok || !data.ok || !data.access_token) {
      throw new BadGatewayException("Slack OAuth refresh failed");
    }

    return {
      accessToken: data.access_token,
      expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : undefined
    };
  }
}
