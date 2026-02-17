import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Post,
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
import { BillingService } from "../billing/billing.service";
import { getActiveOrgId } from "../common/auth-org";
import { assertFeatureEnabled } from "../common/feature-flags";
import { JobQueueService } from "../queue/job-queue.service";
import { QUEUE_NAMES } from "../jobs/queues";
import { AiService } from "./ai.service";

@Controller()
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly billingService: BillingService,
    private readonly jwtService: JwtService,
    private readonly jobQueueService: JobQueueService
  ) {}

  @Post("ai/compute-insights")
  async computeInsights(
    @Headers("x-jobs-secret") jobsSecretHeader: string | undefined,
    @Req()
    req: {
      headers: { authorization?: string; "x-org-id"?: string };
      cookies?: Record<string, string | undefined>;
      user?: AuthUserContext;
    }
  ) {
    assertFeatureEnabled("FEATURE_AI_ENABLED");
    const auth = this.assertAdminOrSecret(req, jobsSecretHeader);
    const orgId = auth.orgId;
    await this.billingService.assertFeature(orgId, "revenueIntelligenceEnabled");
    if (!this.isJobsEnabled()) {
      return this.aiService.computeInsights(orgId);
    }
    return this.jobQueueService.runNow(QUEUE_NAMES.ai, "compute-insights", { orgId });
  }

  @Get("ceo/insights")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CEO, Role.ADMIN)
  async listInsights(@Req() req: { user: AuthUserContext }) {
    assertFeatureEnabled("FEATURE_AI_ENABLED");
    const orgId = getActiveOrgId(req);
    await this.billingService.assertFeature(orgId, "revenueIntelligenceEnabled");
    return this.aiService.listUnresolved(orgId);
  }

  @Post("ceo/insights/:id/resolve")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CEO, Role.ADMIN)
  async resolveInsight(
    @Param("id") insightId: string,
    @Req() req: { user: AuthUserContext }
  ) {
    assertFeatureEnabled("FEATURE_AI_ENABLED");
    const orgId = getActiveOrgId(req);
    await this.billingService.assertFeature(orgId, "revenueIntelligenceEnabled");
    return this.aiService.resolveInsight(orgId, insightId, req.user.userId);
  }

  private assertAdminOrSecret(
    req: {
      headers: { authorization?: string; "x-org-id"?: string };
      cookies?: Record<string, string | undefined>;
    },
    jobsSecretHeader: string | undefined
  ): { orgId: string } {
    if (this.isSecretAuthorized(jobsSecretHeader)) {
      const scopedOrgId = req.headers["x-org-id"];
      if (scopedOrgId) {
        return { orgId: scopedOrgId };
      }
    }

    const payload = this.assertAdmin(req);
    return {
      orgId: payload.activeOrgId ?? payload.orgId
    };
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

  private isJobsEnabled(): boolean {
    return (process.env.JOBS_ENABLED ?? "true").toLowerCase() === "true";
  }
}
