import { Injectable, Logger } from "@nestjs/common";
import { createHash, createHmac } from "node:crypto";
import { decryptAppConfig } from "../marketplace/app-config-crypto.util";
import { decryptAppSecret } from "../marketplace/app-secret-crypto.util";
import { PrismaService } from "../prisma/prisma.service";

type DispatchEndpoint = {
  id: string;
  orgId: string;
  url: string;
  secret: string;
  failureCount: number;
};

type DispatchOptions = {
  extraHeaders?: Record<string, string>;
  onSuccess?: () => Promise<void>;
};

type AppInstallCandidate = {
  installId: string;
  orgId: string;
  appKey: string;
  webhookUrl: string;
  secret: string;
};

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(private readonly prisma: PrismaService) {}

  async dispatch(orgId: string, eventName: string, payload: Record<string, unknown>): Promise<void> {
    const body = JSON.stringify(payload);

    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: {
        orgId,
        isActive: true,
        url: {
          not: {
            startsWith: "app-install://"
          }
        }
      },
      select: {
        id: true,
        orgId: true,
        url: true,
        secret: true,
        events: true,
        failureCount: true
      }
    });

    if (endpoints.length > 0) {
      const matching = endpoints.filter((endpoint) => this.supportsEvent(endpoint.events, eventName));
      if (matching.length > 0) {
        await Promise.all(matching.map((endpoint) => this.dispatchToEndpoint(endpoint, eventName, body)));
      }
    }

    await this.dispatchToInstalledApps(orgId, eventName, body);
  }

  async retryDelivery(
    orgId: string,
    endpointId: string,
    eventName: string,
    requestBodyHash: string,
    deliveryId: string
  ): Promise<void> {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: {
        id: endpointId,
        orgId,
        url: {
          not: {
            startsWith: "app-install://"
          }
        }
      },
      select: {
        id: true,
        orgId: true,
        url: true,
        secret: true,
        failureCount: true
      }
    });

    if (!endpoint) {
      return;
    }

    const body = JSON.stringify({
      retryOfDeliveryId: deliveryId,
      event: eventName,
      requestBodyHash,
      replayedAt: new Date().toISOString()
    });

    await this.dispatchToEndpoint(endpoint, eventName, body);
  }

  async sendTestTriggerToInstalledApp(
    orgId: string,
    appKey: string,
    eventName: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const install = await this.prisma.orgAppInstall.findFirst({
      where: {
        orgId,
        status: "INSTALLED",
        app: { key: appKey }
      },
      select: {
        id: true,
        orgId: true,
        configEncrypted: true,
        secretEncrypted: true,
        app: {
          select: {
            key: true,
            webhookEvents: true
          }
        }
      }
    });

    if (!install || !install.configEncrypted || !install.secretEncrypted) {
      return;
    }

    if (!this.supportsEvent(install.app.webhookEvents, eventName)) {
      return;
    }

    const config = decryptAppConfig(install.configEncrypted);
    const webhookUrl = typeof config.webhookUrl === "string" ? config.webhookUrl.trim() : "";
    if (!webhookUrl) {
      return;
    }

    const secret = decryptAppSecret(install.secretEncrypted);
    const candidate: AppInstallCandidate = {
      installId: install.id,
      orgId: install.orgId,
      appKey: install.app.key,
      webhookUrl,
      secret
    };

    await this.dispatchToInstalledAppCandidate(candidate, eventName, JSON.stringify(payload));
  }

  async retryInstalledAppDelivery(orgId: string, installId: string, deliveryId: string): Promise<void> {
    const delivery = await this.prisma.webhookDelivery.findFirst({
      where: {
        id: deliveryId,
        orgId,
        endpointId: installId
      },
      select: {
        id: true,
        event: true,
        requestBodyHash: true
      }
    });

    if (!delivery) {
      return;
    }

    const install = await this.prisma.orgAppInstall.findFirst({
      where: {
        id: installId,
        orgId,
        status: "INSTALLED",
        configEncrypted: { not: null },
        secretEncrypted: { not: null }
      },
      select: {
        id: true,
        orgId: true,
        configEncrypted: true,
        secretEncrypted: true,
        app: {
          select: {
            key: true
          }
        }
      }
    });

    if (!install || !install.configEncrypted || !install.secretEncrypted) {
      return;
    }

    const config = decryptAppConfig(install.configEncrypted);
    const webhookUrl = typeof config.webhookUrl === "string" ? config.webhookUrl.trim() : "";
    if (!webhookUrl) {
      return;
    }

    const secret = decryptAppSecret(install.secretEncrypted);
    const candidate: AppInstallCandidate = {
      installId: install.id,
      orgId: install.orgId,
      appKey: install.app.key,
      webhookUrl,
      secret
    };

    const body = JSON.stringify({
      retryOfDeliveryId: delivery.id,
      event: delivery.event,
      requestBodyHash: delivery.requestBodyHash,
      replayedAt: new Date().toISOString()
    });

    await this.dispatchToInstalledAppCandidate(candidate, delivery.event, body);
  }

  private supportsEvent(events: unknown, eventName: string): boolean {
    if (!Array.isArray(events)) {
      return false;
    }
    return events.some((event) => typeof event === "string" && event === eventName);
  }

  private async dispatchToEndpoint(
    endpoint: DispatchEndpoint,
    eventName: string,
    body: string,
    options?: DispatchOptions
  ): Promise<void> {
    const signature = createHmac("sha256", endpoint.secret).update(body).digest("hex");
    const requestBodyHash = createHash("sha256").update(body).digest("hex");
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedAt = Date.now();
      let statusCode: number | null = null;
      let success = false;
      let errorMessage: string | null = null;
      let responseSnippet: string | null = null;

      try {
        const response = await fetch(endpoint.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Kritviya-Event": eventName,
            "X-Kritviya-Signature": signature,
            ...(options?.extraHeaders ?? {})
          },
          body
        });
        statusCode = response.status;
        const responseText = await response.text().catch(() => "");
        responseSnippet = this.truncateSnippet(responseText);
        success = response.ok;

        if (!response.ok) {
          errorMessage = `Webhook responded with status ${response.status}`;
        }
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : "Webhook request failed";
      }

      const durationMs = Date.now() - startedAt;
      await this.prisma.webhookDelivery.create({
        data: {
          orgId: endpoint.orgId,
          endpointId: endpoint.id,
          event: eventName,
          statusCode,
          success,
          error: errorMessage,
          durationMs,
          requestBodyHash,
          responseBodySnippet: responseSnippet,
          attempt
        }
      });

      if (success) {
        await this.prisma.webhookEndpoint.update({
          where: { id: endpoint.id },
          data: {
            failureCount: 0,
            lastFailureAt: null
          }
        });
        if (options?.onSuccess) {
          await options.onSuccess();
        }
        return;
      }

      if (attempt < maxAttempts) {
        await this.delay(150 * 2 ** (attempt - 1));
        continue;
      }

      const updated = await this.prisma.webhookEndpoint.update({
        where: { id: endpoint.id },
        data: {
          failureCount: { increment: 1 },
          lastFailureAt: new Date()
        },
        select: {
          failureCount: true
        }
      });

      if (updated.failureCount >= 10) {
        await this.prisma.webhookEndpoint.update({
          where: { id: endpoint.id },
          data: {
            isActive: false
          }
        });
      }

      this.logger.warn(
        `Webhook delivery failed for endpoint=${endpoint.id} event=${eventName}: ${
          errorMessage ?? "Unknown error"
        }`
      );
    }
  }

  private async dispatchToInstalledApps(orgId: string, eventName: string, body: string): Promise<void> {
    const installs = await this.prisma.orgAppInstall.findMany({
      where: {
        orgId,
        status: "INSTALLED",
        configEncrypted: { not: null },
        secretEncrypted: { not: null }
      },
      select: {
        id: true,
        orgId: true,
        appId: true,
        configEncrypted: true,
        secretEncrypted: true,
        app: {
          select: {
            key: true,
            webhookEvents: true
          }
        }
      }
    });

    const candidates = installs
      .map((install) => {
        const supportsEvent = this.supportsEvent(install.app.webhookEvents, eventName);
        if (!supportsEvent || !install.configEncrypted || !install.secretEncrypted) {
          return null;
        }

        try {
          const config = decryptAppConfig(install.configEncrypted);
          const webhookUrl = typeof config.webhookUrl === "string" ? config.webhookUrl.trim() : "";
          if (!webhookUrl) {
            return null;
          }
          const secret = decryptAppSecret(install.secretEncrypted);
          return {
            installId: install.id,
            orgId: install.orgId,
            appKey: install.app.key,
            webhookUrl,
            secret
          };
        } catch {
          return null;
        }
      })
      .filter(
        (value): value is AppInstallCandidate => Boolean(value)
      );

    if (candidates.length === 0) {
      return;
    }

    await Promise.all(
      candidates.map((candidate) => this.dispatchToInstalledAppCandidate(candidate, eventName, body))
    );
  }

  private async dispatchToInstalledAppCandidate(
    candidate: AppInstallCandidate,
    eventName: string,
    body: string
  ): Promise<void> {
    const endpoint = await this.ensureInstallDeliveryEndpoint(candidate);
    await this.dispatchToEndpoint(endpoint, eventName, body, {
      extraHeaders: {
        "X-Kritviya-App-Key": candidate.appKey
      },
      onSuccess: async () => {
        await this.prisma.orgAppInstall.update({
          where: { id: candidate.installId },
          data: { lastUsedAt: new Date() }
        });
      }
    });
  }

  private async ensureInstallDeliveryEndpoint(candidate: AppInstallCandidate): Promise<DispatchEndpoint> {
    const endpoint = await this.prisma.webhookEndpoint.upsert({
      where: { id: candidate.installId },
      update: {
        orgId: candidate.orgId,
        url: `app-install://${candidate.appKey}`,
        secret: candidate.secret,
        events: []
      },
      create: {
        id: candidate.installId,
        orgId: candidate.orgId,
        url: `app-install://${candidate.appKey}`,
        secret: candidate.secret,
        events: []
      },
      select: {
        id: true,
        orgId: true,
        url: true,
        secret: true,
        failureCount: true
      }
    });

    return endpoint;
  }

  private truncateSnippet(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    return trimmed.length > 1024 ? trimmed.slice(0, 1024) : trimmed;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
