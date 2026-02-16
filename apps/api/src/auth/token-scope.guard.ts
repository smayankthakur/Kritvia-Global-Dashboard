import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthUserContext } from "./auth.types";
import { TOKEN_SCOPE_KEY } from "./token-scope.decorator";
import { ApiTokenScope } from "./token-scope.constants";
import { assertTokenScope } from "./token-scope.helper";

@Injectable()
export class TokenScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredScope = this.reflector.getAllAndOverride<ApiTokenScope>(TOKEN_SCOPE_KEY, [
      context.getHandler(),
      context.getClass()
    ]);
    if (!requiredScope) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ user?: AuthUserContext }>();
    if (!request.user) {
      throw new UnauthorizedException("Missing authenticated user");
    }

    if (!request.user.isServiceAccount) {
      return true;
    }

    assertTokenScope(requiredScope, request.user.serviceAccountScopes);
    return true;
  }
}
