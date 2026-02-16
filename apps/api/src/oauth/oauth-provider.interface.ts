export interface OAuthExchangeResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scope?: string;
  accountId?: string;
}

export interface OAuthRefreshResult {
  accessToken: string;
  expiresAt?: Date;
}

export interface OAuthProvider {
  getAuthUrl(state: string): string;
  exchangeCode(code: string): Promise<OAuthExchangeResult>;
  refreshToken(refreshToken: string): Promise<OAuthRefreshResult>;
}
