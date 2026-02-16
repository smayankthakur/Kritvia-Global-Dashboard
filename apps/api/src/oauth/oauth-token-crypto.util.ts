import { decryptAppConfig, encryptAppConfig } from "../marketplace/app-config-crypto.util";

const TOKEN_FIELD = "token";

export function encryptOAuthToken(token: string): string {
  return encryptAppConfig({ [TOKEN_FIELD]: token });
}

export function decryptOAuthToken(encryptedToken: string): string {
  const payload = decryptAppConfig(encryptedToken);
  const token = payload[TOKEN_FIELD];
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Invalid encrypted OAuth token payload");
  }
  return token;
}
