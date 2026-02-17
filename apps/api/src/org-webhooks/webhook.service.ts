import { Injectable, Logger } from "@nestjs/common";
import { createHash, createHmac } from "node:crypto";
import { AlertingService } from "../alerts/alerting.service";
import { JobService } from "../jobs/job.service";
import { QUEUE_NAMES } from "../jobs/queues";
import { decryptAppConfig } from "../marketplace/app-config-crypto.util";
import { decryptAppSecret } from "../marketplace/app-secret-crypto.util";
import { PrismaService } from "../prisma/prisma.service";

type DispatchEndpoint = {
  id: string;
  orgId: string;
  url: string;
  secret: string;
  failureCount: number;
  appKey?: string | null;
  appInstallId?: string | null;
};

type AppInstallCandidate = {
  installId: string;
  orgId: string;
  appKey: string;
  webhookUrl: string;
  secret: string;
};

type DispatchJobPayload = {
  orgId: string;
  endpointId: string;
  url: string;
  secret: string;
  failureCount: number;
  eventName: string;
  body: string;
  appKey?: string | null;
  appInstallId?: string | null;
};

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobService: JobService,
    private readonly alertingService: AlertingService
  ) {}

  async dispatch(orgId: string, eventName: string, payload: Record<string, unknown>): Promise<void> {
    if ((process.env.JOBS_ENABLED ?? "true").toLowerCase() !== "true") {
      // Fallback for local mode without queue workers.
      const body = JSON.stringify(payload);
      const jobs = await this.collectDispatchJobs(orgId, eventName, body);
      for (const job of jobs) {
        await this.processDispatchJob(job).catch((error) => {
          this.logger.warn(
            `Inline webhook dispatch failed for endpoint=${job.endpointId}: ${
              error instanceof Error ? error.message : "unknown"
            }`
          );
        });
      }
      return;
    }

    const body = JSON.stringify(payload);
    const jobs = await this.collectDispatchJobs(orgId, eventName, body);
    await Promise.all(
      jobs.map((job) =>
        this.jobService.enqueue(QUEUE_NAMES.webhooks, "webhook-dispatch", job, {
          attempts: 1
        })
      )
    );
  }

  async processDispatchJob(payload: Record<string, unknown>): Promise<void> {
    const job = this.toDispatchJob(payload);
    await this.dispatchToEndpoint(
      {
        id: job.endpointId,
        orgId: job.orgId,
        url: job.url,
        secret: job.secret,
        failureCount: job.failureCount,
        appKey: job.appKey,
        appInstallId: job.appInstallId
      },
      job.eventName,
      job.body
    );
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

  private async collectDispatchJobs(
    orgId: string,
    eventName: string,
    body: string
  ): Promise<DispatchJobPayload[]> {
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

    const endpointJobs: DispatchJobPayload[] = endpoints
      .filter((endpoint) => this.supportsEvent(endpoint.events, eventName))
      .map((endpoint) => ({
        orgId: endpoint.orgId,
        endpointId: endpoint.id,
        url: endpoint.url,
        secret: endpoint.secret,
        failureCount: endpoint.failureCount,
        eventName,
        body
      }));

    const appJobs = await this.collectInstalledAppDispatchJobs(orgId, eventName, body);
    return [...endpointJobs, ...appJobs];
  }

  private async collectInstalledAppDispatchJobs(
    orgId: string,
    eventName: string,
    body: string
  ): Promise<DispatchJobPayload[]> {
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

    const jobs: DispatchJobPayload[] = [];
    for (const install of installs) {
      const supportsEvent = this.supportsEvent(install.app.webhookEvents, eventName);
      if (!supportsEvent || !install.configEncrypted || !install.secretEncrypted) {
        continue;
      }

      try {
        const config = decryptAppConfig(install.configEncrypted);
        const webhookUrl = typeof config.webhookUrl === "string" ? config.webhookUrl.trim() : "";
        if (!webhookUrl) {
          continue;
        }

        const secret = decryptAppSecret(install.secretEncrypted);
        jobs.push({
          orgId: install.orgId,
          endpointId: install.id,
          url: webhookUrl,
          secret,
          failureCount: 0,
          eventName,
          body,
          appKey: install.app.key,
          appInstallId: install.id
        });
      } catch {
        continue;
      }
    }

    return jobs;
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
    body: string
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
            ...(endpoint.appKey ? { "X-Kritviya-App-Key": endpoint.appKey } : {})
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
        if (endpoint.appInstallId) {
          await this.prisma.orgAppInstall.update({
            where: { id: endpoint.appInstallId },
            data: { lastUsedAt: new Date() }
          });
        } else {
          await this.prisma.webhookEndpoint.update({
            where: { id: endpoint.id },
            data: {
              failureCount: 0,
              lastFailureAt: null
            }
          });
        }
        return;
      }

      if (attempt < maxAttempts) {
        await this.delay(150 * 2 ** (attempt - 1));
        continue;
      }

      if (!endpoint.appInstallId) {
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
      }

      this.logger.warn(
        `Webhook delivery failed for endpoint=${endpoint.id} event=${eventName}: ${
          errorMessage ?? "Unknown error"
        }`
      );

      await this.alertingService.recordFailure("WEBHOOK_FAILURE_SPIKE", endpoint.orgId, {
        endpointId: endpoint.id,
        appInstallId: endpoint.appInstallId ?? undefined,
        eventName,
        queue: QUEUE_NAMES.webhooks,
        reason: errorMessage ?? "Unknown error"
      });

      throw new Error(errorMessage ?? "Webhook delivery failed");
    }
  }

  private async dispatchToInstalledAppCandidate(
    candidate: AppInstallCandidate,
    eventName: string,
    body: string
  ): Promise<void> {
    const payload: DispatchJobPayload = {
      orgId: candidate.orgId,
      endpointId: candidate.installId,
      url: candidate.webhookUrl,
      secret: candidate.secret,
      failureCount: 0,
      eventName,
      body,
      appKey: candidate.appKey,
      appInstallId: candidate.installId
    };

    if ((process.env.JOBS_ENABLED ?? "true").toLowerCase() !== "true") {
      await this.processDispatchJob(payload);
      return;
    }

    await this.jobService.enqueue(QUEUE_NAMES.webhooks, "webhook-dispatch", payload, {
      attempts: 1
    });
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

  private toDispatchJob(payload: Record<string, unknown>): DispatchJobPayload {
    return {
      orgId: String(payload.orgId ?? ""),
      endpointId: String(payload.endpointId ?? ""),
      url: String(payload.url ?? ""),
      secret: String(payload.secret ?? ""),
      failureCount: Number(payload.failureCount ?? 0),
      eventName: String(payload.eventName ?? ""),
      body: String(payload.body ?? ""),
      appKey: typeof payload.appKey === "string" ? payload.appKey : null,
      appInstallId: typeof payload.appInstallId === "string" ? payload.appInstallId : null
    };
  }
}
