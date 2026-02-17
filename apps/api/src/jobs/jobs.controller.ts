import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Post,
  Req,
  UnauthorizedException
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Role } from "@prisma/client";
import { AuthTokenPayload } from "../auth/auth.types";
import { BillingService } from "../billing/billing.service";
import { assertFeatureEnabled } from "../common/feature-flags";
import { QueueName } from "./queues";
import { JobService } from "./job.service";

@Controller("jobs")
export class JobsController {
  constructor(
    private readonly jobService: JobService,
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
    const auth = this.assertAdminOrSecret(req, jobsSecretHeader);
    if (auth.type === "jwt") {
      await this.billingService.assertFeature(auth.orgId, "autopilotEnabled");
    }

    return this.jobService.runNow("maintenance", "autopilot-run", { kind: "autopilot-run" });
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
    this.assertAdminOrSecret(req, jobsSecretHeader);
    return this.jobService.runNow("maintenance", "retention-run", { kind: "retention-run" });
  }

  @Get("status/:queue/:jobId")
  async getJobStatus(
    @Param("queue") queue: QueueName,
    @Param("jobId") jobId: string,
    @Req()
    req: {
      headers: { authorization?: string };
      cookies?: Record<string, string | undefined>;
    }
  ) {
    this.assertAdmin(req);
    return this.jobService.getStatus(queue, jobId);
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

  private assertAdminOrSecret(
    req: {
      headers: { authorization?: string };
      cookies?: Record<string, string | undefined>;
    },
    jobsSecretHeader: string | undefined
  ): { type: "secret" } | { type: "jwt"; orgId: string } {
    if (this.isSecretAuthorized(jobsSecretHeader)) {
      return { type: "secret" };
    }
    const payload = this.assertAdmin(req);
    return { type: "jwt", orgId: payload.activeOrgId ?? payload.orgId };
  }

}
