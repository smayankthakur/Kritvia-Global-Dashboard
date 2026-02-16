import { UnauthorizedException } from "@nestjs/common";
import { AuthUserContext } from "../auth/auth.types";

export function getActiveOrgId(request: { user?: Partial<AuthUserContext> | undefined }): string {
  const orgId = request.user?.activeOrgId ?? request.user?.orgId;
  if (!orgId) {
    throw new UnauthorizedException("Missing active org scope");
  }
  return orgId;
}

