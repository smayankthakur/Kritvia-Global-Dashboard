import { SetMetadata } from "@nestjs/common";
import { ApiTokenScope } from "./token-scope.constants";

export const TOKEN_SCOPE_KEY = "token-scope";

export const RequireTokenScope = (scope: ApiTokenScope): MethodDecorator =>
  SetMetadata(TOKEN_SCOPE_KEY, scope);
