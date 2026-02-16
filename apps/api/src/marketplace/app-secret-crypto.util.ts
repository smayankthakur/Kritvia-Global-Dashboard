import { decryptAppConfig, encryptAppConfig } from "./app-config-crypto.util";

const SECRET_KEY = "secret";

export function encryptAppSecret(secret: string): string {
  return encryptAppConfig({ [SECRET_KEY]: secret });
}

export function decryptAppSecret(encryptedSecret: string): string {
  const payload = decryptAppConfig(encryptedSecret);
  const secret = payload[SECRET_KEY];
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("Invalid encrypted app secret payload");
  }
  return secret;
}
