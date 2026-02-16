import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function parseEncryptionKey(): Buffer {
  const rawKey = process.env.APP_CONFIG_ENCRYPTION_KEY;
  if (!rawKey) {
    throw new Error("Missing APP_CONFIG_ENCRYPTION_KEY");
  }

  const trimmed = rawKey.trim();
  if (/^[A-Fa-f0-9]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  const base64Buffer = Buffer.from(trimmed, "base64");
  if (base64Buffer.length === 32) {
    return base64Buffer;
  }

  throw new Error("APP_CONFIG_ENCRYPTION_KEY must be 32-byte hex or base64 value");
}

function toSafeJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export function encryptAppConfig(config: Record<string, unknown>): string {
  const key = parseEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(toSafeJson(config), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${ciphertext.toString("base64")}`;
}

export function decryptAppConfig(encryptedValue: string): Record<string, unknown> {
  const [ivB64, tagB64, ciphertextB64] = encryptedValue.split(".");
  if (!ivB64 || !tagB64 || !ciphertextB64) {
    throw new Error("Invalid encrypted app config format");
  }

  const key = parseEncryptionKey();
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  return JSON.parse(plaintext) as Record<string, unknown>;
}
