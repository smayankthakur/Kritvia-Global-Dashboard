import { BadGatewayException, InternalServerErrorException } from "@nestjs/common";
import { OAuthExchangeResult, OAuthProvider, OAuthRefreshResult } from "../oauth-provider.interface";

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

export class GoogleOAuthProvider implements OAuthProvider {
  getAuthUrl(state: string): string {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;
    if (!clientId || !redirectUri) {
      throw new InternalServerErrorException("Google OAuth is not configured");
    }

    const scope =
      process.env.GOOGLE_OAUTH_SCOPES ??
      "openid email profile https://www.googleapis.com/auth/spreadsheets.readonly";
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", scope);
    url.searchParams.set("state", state);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set("prompt", "consent");
    return url.toString();
  }

  async exchangeCode(code: string): Promise<OAuthExchangeResult> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) {
      throw new InternalServerErrorException("Google OAuth is not configured");
    }

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri
    });

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const data = (await response.json()) as GoogleTokenResponse;
    if (!response.ok || !data.access_token) {
      throw new BadGatewayException("Google OAuth token exchange failed");
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : undefined,
      scope: data.scope,
      accountId: data.id_token
    };
  }

  async refreshToken(refreshToken: string): Promise<OAuthRefreshResult> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new InternalServerErrorException("Google OAuth is not configured");
    }

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    });

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const data = (await response.json()) as GoogleTokenResponse;
    if (!response.ok || !data.access_token) {
      throw new BadGatewayException("Google OAuth refresh failed");
    }

    return {
      accessToken: data.access_token,
      expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : undefined
    };
  }
}
