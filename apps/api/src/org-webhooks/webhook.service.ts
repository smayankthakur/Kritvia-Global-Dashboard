import { Injectable, Logger } from "@nestjs/common";
import { createHmac } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(private readonly prisma: PrismaService) {}

  async dispatch(orgId: string, eventName: string, payload: Record<string, unknown>): Promise<void> {
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: {
        orgId,
        isActive: true
      },
      select: {
        id: true,
        url: true,
        secret: true,
        events: true,
        failureCount: true
      }
    });

    if (endpoints.length === 0) {
      return;
    }

    const body = JSON.stringify(payload);
    const matching = endpoints.filter((endpoint) => this.supportsEvent(endpoint.events, eventName));
    if (matching.length === 0) {
      return;
    }

    await Promise.all(
      matching.map((endpoint) => this.dispatchToEndpoint(endpoint, eventName, body))
    );
  }

  private supportsEvent(events: unknown, eventName: string): boolean {
    if (!Array.isArray(events)) {
      return false;
    }
    return events.some((event) => typeof event === "string" && event === eventName);
  }

  private async dispatchToEndpoint(
    endpoint: { id: string; url: string; secret: string; failureCount: number },
    eventName: string,
    body: string
  ): Promise<void> {
    const signature = createHmac("sha256", endpoint.secret).update(body).digest("hex");
    const maxAttempts = 3;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const response = await fetch(endpoint.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Kritviya-Event": eventName,
            "X-Kritviya-Signature": signature
          },
          body
        });

        if (!response.ok) {
          throw new Error(`Webhook responded with status ${response.status}`);
        }

        await this.prisma.webhookEndpoint.update({
          where: { id: endpoint.id },
          data: {
            failureCount: 0,
            lastFailureAt: null
          }
        });
        return;
      } catch (error) {
        if (attempt < maxAttempts - 1) {
          await this.delay(150 * 2 ** attempt);
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
            error instanceof Error ? error.message : "Unknown error"
          }`
        );
      }
    }
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
