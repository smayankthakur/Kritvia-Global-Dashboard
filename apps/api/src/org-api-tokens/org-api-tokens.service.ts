import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, Role } from "@prisma/client";
import { randomBytes, createHash } from "node:crypto";
import { AuthUserContext } from "../auth/auth.types";
import { BillingService } from "../billing/billing.service";
import { getActiveOrgId } from "../common/auth-org";
import { PrismaService } from "../prisma/prisma.service";
import { CreateApiTokenDto } from "./dto/create-api-token.dto";

@Injectable()
export class OrgApiTokensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billingService: BillingService
  ) {}

  async create(authUser: AuthUserContext, dto: CreateApiTokenDto): Promise<{
    id: string;
    name: string;
    role: Role;
    scopes: string[] | null;
    token: string;
  }> {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");

    const normalizedScopes = this.normalizeScopes(dto.scopes);
    const rawToken = `ktv_live_${randomBytes(32).toString("hex")}`;
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const created = await this.prisma.apiToken.create({
      data: {
        orgId,
        name: dto.name.trim(),
        role: dto.role ?? Role.ADMIN,
        scopes: normalizedScopes ?? undefined,
        tokenHash
      },
      select: {
        id: true,
        name: true,
        role: true,
        scopes: true
      }
    });

    return {
      id: created.id,
      name: created.name,
      role: created.role,
      scopes: this.parseScopes(created.scopes),
      token: rawToken
    };
  }

  async list(authUser: AuthUserContext): Promise<
    Array<{
      id: string;
      name: string;
      role: Role;
      scopes: string[] | null;
      createdAt: Date;
      lastUsedAt: Date | null;
      revokedAt: Date | null;
    }>
  > {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");

    return this.prisma.apiToken.findMany({
      where: { orgId },
      select: {
        id: true,
        name: true,
        role: true,
        scopes: true,
        createdAt: true,
        lastUsedAt: true,
        revokedAt: true
      },
      orderBy: [{ createdAt: "desc" }]
    }).then((tokens) =>
      tokens.map((token) => ({
        ...token,
        scopes: this.parseScopes(token.scopes)
      }))
    );
  }

  async revoke(authUser: AuthUserContext, tokenId: string): Promise<{ success: true }> {
    const orgId = getActiveOrgId({ user: authUser });
    await this.billingService.assertFeature(orgId, "enterpriseControlsEnabled");

    const update = await this.prisma.apiToken.updateMany({
      where: {
        id: tokenId,
        orgId,
        revokedAt: null
      },
      data: {
        revokedAt: new Date()
      }
    });

    if (update.count === 0) {
      throw new NotFoundException("API token not found");
    }

    return { success: true };
  }

  private normalizeScopes(scopes?: string[]): Prisma.InputJsonValue | null {
    if (!scopes || scopes.length === 0) {
      return null;
    }
    return Array.from(new Set(scopes.map((scope) => scope.trim()).filter(Boolean)));
  }

  private parseScopes(scopes: unknown): string[] | null {
    if (!Array.isArray(scopes)) {
      return null;
    }
    const normalized = scopes.filter((scope) => typeof scope === "string");
    return normalized.length > 0 ? normalized : null;
  }
}
