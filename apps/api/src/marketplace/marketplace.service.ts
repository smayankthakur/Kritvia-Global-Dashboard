import { Injectable, NotFoundException } from "@nestjs/common";
import { AuthUserContext } from "../auth/auth.types";
import { getActiveOrgId } from "../common/auth-org";
import { toPaginatedResponse } from "../common/dto/paginated-response.dto";
import { PrismaService } from "../prisma/prisma.service";
import { ListMarketplaceAppsDto } from "./dto/list-marketplace-apps.dto";

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

@Injectable()
export class MarketplaceService {
  constructor(private readonly prisma: PrismaService) {}

  async listPublished(dto: ListMarketplaceAppsDto) {
    const where: {
      isPublished: true;
      category?: string;
      OR?: Array<Record<string, { contains: string; mode: "insensitive" }>>;
    } = { isPublished: true };

    if (dto.category?.trim()) {
      where.category = dto.category.trim();
    }

    if (dto.q?.trim()) {
      const query = dto.q.trim();
      where.OR = [
        { name: { contains: query, mode: "insensitive" } },
        { key: { contains: query, mode: "insensitive" } },
        { description: { contains: query, mode: "insensitive" } }
      ];
    }

    const skip = (dto.page - 1) * dto.pageSize;
    const [apps, total] = await this.prisma.$transaction([
      this.prisma.marketplaceApp.findMany({
        where,
        orderBy: [{ name: "asc" }],
        skip,
        take: dto.pageSize
      }),
      this.prisma.marketplaceApp.count({ where })
    ]);

    const items = apps.map((app) => ({
      id: app.id,
      key: app.key,
      name: app.name,
      description: app.description,
      developerName: app.developerName,
      websiteUrl: app.websiteUrl,
      iconUrl: app.iconUrl,
      category: app.category,
      scopes: asStringArray(app.scopes),
      webhookEvents: asStringArray(app.webhookEvents),
      oauthProvider: app.oauthProvider,
      isPublished: app.isPublished,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt
    }));

    return toPaginatedResponse(items, dto.page, dto.pageSize, total);
  }

  async getByKey(key: string, authUser: AuthUserContext) {
    const app = await this.prisma.marketplaceApp.findUnique({
      where: { key }
    });
    if (!app || !app.isPublished) {
      throw new NotFoundException("Marketplace app not found");
    }

    const activeOrgId = getActiveOrgId({ user: authUser });
    const install = await this.prisma.orgAppInstall.findUnique({
      where: {
        orgId_appId: {
          orgId: activeOrgId,
          appId: app.id
        }
      },
      select: {
        id: true,
        status: true,
        installedAt: true,
        disabledAt: true,
        uninstalledAt: true,
        configVersion: true,
        lastUsedAt: true,
        oauthProvider: true,
        oauthAccessTokenEncrypted: true,
        oauthExpiresAt: true,
        oauthAccountId: true
      }
    });

    return {
      id: app.id,
      key: app.key,
      name: app.name,
      description: app.description,
      developerName: app.developerName,
      websiteUrl: app.websiteUrl,
      iconUrl: app.iconUrl,
      category: app.category,
      scopes: asStringArray(app.scopes),
      webhookEvents: asStringArray(app.webhookEvents),
      oauthProvider: app.oauthProvider,
      isPublished: app.isPublished,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
      installed: Boolean(install && install.status !== "UNINSTALLED"),
      install: install
        ? {
            id: install.id,
            status: install.status,
            installedAt: install.installedAt,
            disabledAt: install.disabledAt,
            uninstalledAt: install.uninstalledAt,
            configVersion: install.configVersion,
            lastUsedAt: install.lastUsedAt,
            oauthProvider: install.oauthProvider,
            oauthExpiresAt: install.oauthExpiresAt,
            oauthAccountId: install.oauthAccountId,
            oauthConnected: Boolean(install.oauthAccessTokenEncrypted)
          }
        : null
    };
  }
}
