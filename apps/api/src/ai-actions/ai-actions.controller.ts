import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Role } from "@prisma/client";
import { AuthTokenPayload, AuthUserContext } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { getActiveOrgId } from "../common/auth-org";
import { ListAiActionsDto } from "./dto/list-ai-actions.dto";
import { AiActionsService } from "./ai-actions.service";

@Controller()
export class AiActionsController {
  constructor(
    private readonly aiActionsService: AiActionsService,
    private readonly jwtService: JwtService
  ) {}

  @Post("ai/compute-actions")
  async computeActions(
    @Headers("x-jobs-secret") jobsSecretHeader: string | undefined,
    @Req()
    req: {
      headers: { authorization?: string; "x-org-id"?: string };
      cookies?: Record<string, string | undefined>;
    }
  ) {
    const orgId = this.assertAdminOrSecret(req, jobsSecretHeader);
    return this.aiActionsService.computeActions(orgId);
  }

  @Get("ai/actions")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CEO, Role.ADMIN)
  async listActions(@Req() req: { user: AuthUserContext }, @Query() query: ListAiActionsDto) {
    const orgId = getActiveOrgId(req);
    return this.aiActionsService.listActions(orgId, query);
  }

  @Post("ai/actions/:id/approve")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CEO, Role.ADMIN)
  async approve(@Param("id") id: string, @Req() req: { user: AuthUserContext }) {
    const orgId = getActiveOrgId(req);
    return this.aiActionsService.approveAction(orgId, id, req.user.userId);
  }

  @Post("ai/actions/:id/execute")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CEO, Role.ADMIN, Role.OPS)
  async execute(@Param("id") id: string, @Req() req: { user: AuthUserContext }) {
    const orgId = getActiveOrgId(req);
    return this.aiActionsService.executeAction(orgId, id, req.user);
  }

  @Post("ai/actions/:id/undo")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CEO, Role.ADMIN)
  async undo(@Param("id") id: string, @Req() req: { user: AuthUserContext }) {
    const orgId = getActiveOrgId(req);
    return this.aiActionsService.undoAction(orgId, id, req.user.userId);
  }

  private assertAdminOrSecret(
    req: {
      headers: { authorization?: string; "x-org-id"?: string };
      cookies?: Record<string, string | undefined>;
    },
    jobsSecretHeader: string | undefined
  ): string {
    if (this.isSecretAuthorized(jobsSecretHeader)) {
      const scopedOrgId = req.headers["x-org-id"];
      if (!scopedOrgId) {
        throw new UnauthorizedException("X-ORG-ID header is required for secret-based execution");
      }
      return scopedOrgId;
    }

    const payload = this.assertAdmin(req);
    return payload.activeOrgId ?? payload.orgId;
  }

  private assertAdmin(req: {
    headers: { authorization?: string };
    cookies?: Record<string, string | undefined>;
  }): AuthTokenPayload {
    const authHeader = req.headers.authorization;
    const bearerToken =
      authHeader && authHeader.startsWith("Bearer ")
        ? authHeader.slice("Bearer ".length).trim()
        : undefined;
    const cookieToken = req.cookies?.kritviya_access_token;
    const token = bearerToken ?? cookieToken;
    if (!token) {
      throw new UnauthorizedException("Missing bearer token");
    }

    let payload: AuthTokenPayload;
    try {
      payload = this.jwtService.verify<AuthTokenPayload>(token, {
        secret: process.env.JWT_SECRET
      });
    } catch {
      throw new UnauthorizedException("Invalid or expired token");
    }

    if (payload.role !== Role.ADMIN) {
      throw new ForbiddenException("Insufficient role permissions");
    }
    return payload;
  }

  private isSecretAuthorized(headerValue: string | undefined): boolean {
    const configuredSecret = process.env.JOBS_SECRET;
    if (!configuredSecret || !headerValue) {
      return false;
    }
    return configuredSecret === headerValue;
  }
}
