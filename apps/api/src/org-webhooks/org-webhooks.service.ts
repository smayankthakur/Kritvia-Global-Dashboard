import { Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { AuthUserContext } from "../auth/auth.types";
import { BillingService } from "../billing/billing.service";
import { getActiveOrgId } from "../common/auth-org";
import { PrismaService } from "../prisma/prisma.service";
import { CreateWebhookEndpointDto } from "./dto/create-webhook-endpoint.dto";

@Injectable()
export class OrgWebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billingService: BillingService
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

  async list(authUser: AuthUserContext) {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");

    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { orgId },
      select: {
        id: true,
        url: true,
        events: true,
        isActive: true,
        lastFailureAt: true,
        failureCount: true,
        createdAt: true
      },
      orderBy: [{ createdAt: "desc" }]
    });

    return endpoints.map((endpoint) => ({
      id: endpoint.id,
      url: endpoint.url,
      events: this.parseEvents(endpoint.events),
      isActive: endpoint.isActive,
      lastFailureAt: endpoint.lastFailureAt,
      failureCount: endpoint.failureCount,
      createdAt: endpoint.createdAt
    }));
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

  private parseEvents(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((event): event is string => typeof event === "string");
  }
}
