import { ForbiddenException } from "@nestjs/common";
import { ApiTokenScope } from "./token-scope.constants";

export function assertTokenScope(
  requiredScope: ApiTokenScope,
  tokenScopes?: readonly string[] | null
): void {
  // Null/undefined scopes means default full access based on role.
  if (!tokenScopes || tokenScopes.length === 0) {
    return;
  }

  if (tokenScopes.includes("*") || tokenScopes.includes(requiredScope)) {
    return;
  }

  throw new ForbiddenException({
    code: "INSUFFICIENT_SCOPE",
    message: `Missing required scope: ${requiredScope}`
  });
}
