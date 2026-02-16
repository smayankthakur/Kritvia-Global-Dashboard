import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { AuthTokenPayload, AuthUserContext } from "./auth.types";

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{
        headers: { authorization?: string };
        cookies?: Record<string, string | undefined>;
        user?: AuthUserContext;
      }>();
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
      throw new UnauthorizedException("Invalid or expired token");
    }
  }
}
