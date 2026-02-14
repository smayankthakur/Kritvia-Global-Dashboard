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
import { JobsRunService } from "./jobs-run.service";

@Controller("jobs")
export class JobsController {
  constructor(
    private readonly jobsRunService: JobsRunService,
    private readonly jwtService: JwtService
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
    if (this.isSecretAuthorized(jobsSecretHeader)) {
      return this.jobsRunService.run();
    }

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

    return this.jobsRunService.run();
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
