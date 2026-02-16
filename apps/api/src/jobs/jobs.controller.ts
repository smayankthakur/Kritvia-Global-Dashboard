import {
  Controller,
  ForbiddenException,
  Headers,
  Post,
  Req,
  UnauthorizedException
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Role } from "@prisma/client";
import { AuthTokenPayload } from "../auth/auth.types";
import { BillingService } from "../billing/billing.service";
import { assertFeatureEnabled } from "../common/feature-flags";
import { JobsRunService } from "./jobs-run.service";

@Controller("jobs")
export class JobsController {
  constructor(
    private readonly jobsRunService: JobsRunService,
    private readonly jwtService: JwtService,
    private readonly billingService: BillingService
  ) {}

  @Post("run")
  async run(
    @Headers("x-jobs-secret") jobsSecretHeader: string | undefined,
    @Req()
    req: {
      headers: { authorization?: string };
      cookies?: Record<string, string | undefined>;
    }
  ) {
    assertFeatureEnabled("FEATURE_AUTOPILOT_ENABLED");
    if (!this.isSecretAuthorized(jobsSecretHeader)) {
      const payload = this.assertAdmin(req);
      const activeOrgId = payload.activeOrgId ?? payload.orgId;
      await this.billingService.assertFeature(activeOrgId, "autopilotEnabled");
    }

    return this.jobsRunService.run();
  }

  @Post("retention/run")
  async runRetention(
    @Headers("x-jobs-secret") jobsSecretHeader: string | undefined,
    @Req()
    req: {
      headers: { authorization?: string };
      cookies?: Record<string, string | undefined>;
    }
  ) {
    assertFeatureEnabled("FEATURE_AUTOPILOT_ENABLED");
    if (!this.isSecretAuthorized(jobsSecretHeader)) {
      this.assertAdmin(req);
    }

    return this.jobsRunService.runRetention();
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
    if (!configuredSecret) {
      return false;
    }
    if (!headerValue) {
      return false;
    }
    return headerValue === configuredSecret;
  }
}
