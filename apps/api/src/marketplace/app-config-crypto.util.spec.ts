import { decryptAppConfig, encryptAppConfig } from "./app-config-crypto.util";

describe("app-config-crypto util", () => {
  beforeAll(() => {
    process.env.APP_CONFIG_ENCRYPTION_KEY =
      process.env.APP_CONFIG_ENCRYPTION_KEY ||
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  });

  it("encrypts and decrypts config payload", () => {
    const payload = {
      webhookUrl: "https://example.com/hook",
      channel: "#ops-alerts",
      retries: 3
    };

    const encrypted = encryptAppConfig(payload);
    expect(encrypted).not.toContain("ops-alerts");
    expect(encrypted).not.toContain("webhookUrl");

    const decrypted = decryptAppConfig(encrypted);
    expect(decrypted).toEqual(payload);
  });
});
