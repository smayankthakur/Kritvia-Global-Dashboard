import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ActivityEntityType, Prisma } from "@prisma/client";
import { createHash, timingSafeEqual } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AuthTokenPayload, AuthUserContext } from "./auth.types";

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{
        headers: { authorization?: string };
        cookies?: Record<string, string | undefined>;
        method?: string;
        originalUrl?: string;
        url?: string;
        ip?: string;
        socket?: { remoteAddress?: string };
        user?: AuthUserContext;
        __apiTokenUsageLogAttached?: boolean;
      }>();
    const response = context
      .switchToHttp()
      .getResponse<{ statusCode: number; on: (event: "finish", listener: () => void) => void }>();
    const authHeader = request.headers.authorization;
    const bearerToken =
      authHeader && authHeader.startsWith("Bearer ")
        ? authHeader.slice("Bearer ".length).trim()
        : undefined;
    const cookieToken = request.cookies?.kritviya_access_token;
    const token = bearerToken ?? cookieToken;

    if (!token) {
      throw new UnauthorizedException("Missing bearer token");
    }

    try {
      const payload = this.jwtService.verify<AuthTokenPayload>(token, {
        secret: process.env.JWT_SECRET
      });
      // Temporary backward compatibility fallback for older tokens.
      // Remove payload.orgId fallback once all clients issue activeOrgId.
      const resolvedOrgId = payload.activeOrgId ?? payload.orgId;

      request.user = {
        userId: payload.sub,
        orgId: resolvedOrgId,
        activeOrgId: resolvedOrgId,
        role: payload.role,
        email: payload.email,
        name: payload.name
      };

      return true;
    } catch {
      if (bearerToken && bearerToken.startsWith("ktv_live_")) {
        if (bearerToken.length < 40) {
          throw new UnauthorizedException("Invalid or expired token");
        }

        const tokenHash = createHash("sha256").update(bearerToken).digest("hex");
        const matchedAny = await this.prisma.apiToken.findFirst({
          where: { tokenHash },
          select: { id: true, orgId: true }
        });
        const matched = await this.prisma.apiToken.findFirst({
          where: {
            tokenHash,
            revokedAt: null
          }
        });

        if (
          matched &&
          this.constantTimeHashEquals(tokenHash, matched.tokenHash)
        ) {
          this.attachApiTokenUsageLogging(request, response, {
            orgId: matched.orgId,
            tokenId: matched.id
          });

          const now = new Date();
          const oneHourMs = 60 * 60 * 1000;
          const windowExpired =
            !matched.hourWindowStart ||
            now.getTime() - matched.hourWindowStart.getTime() >= oneHourMs;

          const nextWindowStart = windowExpired ? now : matched.hourWindowStart;
          const baselineRequests = windowExpired ? 0 : matched.requestsThisHour;
          const nextRequests = baselineRequests + 1;

          if (nextRequests > matched.rateLimitPerHour) {
            await this.prisma.apiToken.update({
              where: { id: matched.id },
              data: {
                requestsThisHour: nextRequests,
                hourWindowStart: nextWindowStart
              }
            });
            throw new HttpException(
              {
                code: "TOO_MANY_REQUESTS",
                message: "API token rate limit exceeded"
              },
              HttpStatus.TOO_MANY_REQUESTS
            );
          }

          await this.prisma.apiToken.update({
            where: { id: matched.id },
            data: {
              requestsThisHour: nextRequests,
              hourWindowStart: nextWindowStart,
              lastUsedAt: now
            }
          });

          request.user = {
            userId: "api-token",
            orgId: matched.orgId,
            activeOrgId: matched.orgId,
            role: matched.role,
            email: "service-account",
            name: matched.name,
            isServiceAccount: true,
            serviceAccountId: matched.id,
            serviceAccountScopes: this.parseServiceAccountScopes(matched.scopes)
          };
          return true;
        }

        if (matchedAny) {
          this.attachApiTokenUsageLogging(request, response, {
            orgId: matchedAny.orgId,
            tokenId: matchedAny.id
          });
        }
      }

      throw new UnauthorizedException("Invalid or expired token");
    }
  }

  private constantTimeHashEquals(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left, "utf8");
    const rightBuffer = Buffer.from(right, "utf8");
    if (leftBuffer.length !== rightBuffer.length) {
      return false;
    }
    return timingSafeEqual(leftBuffer, rightBuffer);
  }

  private parseServiceAccountScopes(scopes: Prisma.JsonValue | null): string[] | null {
    if (!Array.isArray(scopes)) {
      return null;
    }
    const normalized = scopes.filter((scope) => typeof scope === "string");
    return normalized.length > 0 ? normalized : null;
  }

  private attachApiTokenUsageLogging(
    request: {
      method?: string;
      originalUrl?: string;
      url?: string;
      ip?: string;
      socket?: { remoteAddress?: string };
      __apiTokenUsageLogAttached?: boolean;
    },
    response: { statusCode: number; on: (event: "finish", listener: () => void) => void },
    token: { orgId: string; tokenId: string }
  ): void {
    if (request.__apiTokenUsageLogAttached) {
      return;
    }
    request.__apiTokenUsageLogAttached = true;

    response.on("finish", () => {
      const statusCode = response.statusCode;
      const method = request.method ?? "UNKNOWN";
      const endpoint = request.originalUrl ?? request.url ?? "/";
      const ip = request.ip ?? request.socket?.remoteAddress ?? "unknown";
      const success = statusCode >= 200 && statusCode < 400;
      const apiVersion = endpoint.startsWith("/api/v1") ? "1" : undefined;

      void this.prisma.activityLog
        .create({
          data: {
            orgId: token.orgId,
            entityType: ActivityEntityType.API_TOKEN,
            entityId: token.tokenId,
            action: "API_TOKEN_USED",
            afterJson: {
              endpoint,
              method,
              ip,
              statusCode,
              success,
              apiVersion
            }
          }
        })
        .catch(() => {
          // Fire-and-forget: never block/alter response flow for logging failures.
        });
    });
  }
}
