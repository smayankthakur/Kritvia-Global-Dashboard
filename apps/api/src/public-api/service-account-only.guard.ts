import { Injectable, UnauthorizedException, CanActivate, ExecutionContext } from "@nestjs/common";
import { AuthUserContext } from "../auth/auth.types";

@Injectable()
export class ServiceAccountOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: AuthUserContext }>();
    if (!request.user) {
      throw new UnauthorizedException("Missing authenticated user");
    }
    if (!request.user.isServiceAccount) {
      throw new UnauthorizedException("API token authentication required");
    }
    return true;
  }
}
