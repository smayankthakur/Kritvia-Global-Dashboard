import {
  Controller,
  ForbiddenException,
  Get,
  Query,
  Req,
  UnauthorizedException
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Role } from "@prisma/client";
import { AuthTokenPayload } from "../auth/auth.types";
import { JobService } from "./job.service";
import { QueueName } from "./queues";

@Controller("debug/jobs")
export class DebugJobsController {
  constructor(
    private readonly jobService: JobService,
    private readonly jwtService: JwtService
  ) {}

  @Get("failed")
  async failedJobs(
    @Query("queue") queue: QueueName,
    @Req()
    req: {
      headers: { authorization?: string };
      cookies?: Record<string, string | undefined>;
    }
  ) {
    this.assertAdmin(req);
    const resolvedQueue: QueueName = queue ?? "ai";
    return this.jobService.getFailed(resolvedQueue);
  }

  @Get("stats")
  async stats(
    @Req()
    req: {
      headers: { authorization?: string };
      cookies?: Record<string, string | undefined>;
    }
  ) {
    this.assertAdmin(req);
    return this.jobService.getStats();
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
}
