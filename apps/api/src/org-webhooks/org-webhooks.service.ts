import { Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { AuthUserContext } from "../auth/auth.types";
import { BillingService } from "../billing/billing.service";
import { getActiveOrgId } from "../common/auth-org";
import { toPaginatedResponse } from "../common/dto/paginated-response.dto";
import { PrismaService } from "../prisma/prisma.service";
import { PaginationQueryDto } from "../common/dto/pagination-query.dto";
import { CreateWebhookEndpointDto } from "./dto/create-webhook-endpoint.dto";
import { ListWebhookDeliveriesDto } from "./dto/list-webhook-deliveries.dto";
import { RetryWebhookDeliveryDto } from "./dto/retry-webhook-delivery.dto";
import { WebhookService } from "./webhook.service";

@Injectable()
export class OrgWebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billingService: BillingService,
    private readonly webhookService: WebhookService
  ) {}

  async create(authUser: AuthUserContext, dto: CreateWebhookEndpointDto) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");

    const normalizedEvents = Array.from(
      new Set(dto.events.map((event) => event.trim()).filter((event) => event.length > 0))
    );
    const created = await this.prisma.webhookEndpoint.create({
      data: {
        orgId,
        url: dto.url.trim(),
        secret: randomBytes(32).toString("hex"),
        events: normalizedEvents
      },
      select: {
        id: true,
        url: true,
        events: true,
        isActive: true,
        lastFailureAt: true,
        failureCount: true,
        createdAt: true,
        secret: true
      }
    });

    return {
      id: created.id,
      url: created.url,
      events: this.parseEvents(created.events),
      isActive: created.isActive,
      lastFailureAt: created.lastFailureAt,
      failureCount: created.failureCount,
      createdAt: created.createdAt,
      secret: created.secret
    };
  }

  async list(authUser: AuthUserContext, query: PaginationQueryDto) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");

    const skip = (query.page - 1) * query.pageSize;
    const [endpoints, total] = await this.prisma.$transaction([
      this.prisma.webhookEndpoint.findMany({
        where: {
          orgId,
          url: {
            not: {
              startsWith: "app-install://"
            }
          }
        },
        select: {
          id: true,
          url: true,
          events: true,
          isActive: true,
          lastFailureAt: true,
          failureCount: true,
          createdAt: true
        },
        orderBy: [{ createdAt: "desc" }],
        skip,
        take: query.pageSize
      }),
      this.prisma.webhookEndpoint.count({
        where: {
          orgId,
          url: {
            not: {
              startsWith: "app-install://"
            }
          }
        }
      })
    ]);

    const items = endpoints.map((endpoint) => ({
      id: endpoint.id,
      url: endpoint.url,
      events: this.parseEvents(endpoint.events),
      isActive: endpoint.isActive,
      lastFailureAt: endpoint.lastFailureAt,
      failureCount: endpoint.failureCount,
      createdAt: endpoint.createdAt
    }));
    return toPaginatedResponse(items, query.page, query.pageSize, total);
  }

  async remove(authUser: AuthUserContext, id: string): Promise<{ success: true }> {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");

    const removed = await this.prisma.webhookEndpoint.deleteMany({
      where: {
        id,
        orgId
      }
    });

    if (removed.count === 0) {
      throw new NotFoundException("Webhook endpoint not found");
    }

    return { success: true };
  }

  async listDeliveries(
    authUser: AuthUserContext,
    endpointId: string,
    query: ListWebhookDeliveriesDto
  ) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");

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
        id: true
      }
    });

    if (!endpoint) {
      throw new NotFoundException("Webhook endpoint not found");
    }

    const skip = (query.page - 1) * query.pageSize;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.webhookDelivery.findMany({
        where: {
          orgId,
          endpointId
        },
        orderBy: [{ createdAt: "desc" }],
        skip,
        take: query.pageSize,
        select: {
          id: true,
          orgId: true,
          endpointId: true,
          event: true,
          statusCode: true,
          success: true,
          error: true,
          durationMs: true,
          requestBodyHash: true,
          responseBodySnippet: true,
          attempt: true,
          createdAt: true
        }
      }),
      this.prisma.webhookDelivery.count({
        where: {
          orgId,
          endpointId
        }
      })
    ]);

    return toPaginatedResponse(items, query.page, query.pageSize, total);
  }

  async retryDelivery(
    authUser: AuthUserContext,
    endpointId: string,
    dto: RetryWebhookDeliveryDto
  ): Promise<{ success: true }> {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");

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
        id: true
      }
    });

    if (!endpoint) {
      throw new NotFoundException("Webhook endpoint not found");
    }

    const delivery = await this.prisma.webhookDelivery.findFirst({
      where: {
        id: dto.deliveryId,
        endpointId,
        orgId
      },
      select: {
        id: true,
        event: true,
        requestBodyHash: true
      }
    });

    if (!delivery) {
      throw new NotFoundException("Webhook delivery not found");
    }

    await this.webhookService.retryDelivery(
      orgId,
      endpointId,
      delivery.event,
      delivery.requestBodyHash,
      delivery.id
    );

    return { success: true };
  }

  private parseEvents(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((event): event is string => typeof event === "string");
  }
}
