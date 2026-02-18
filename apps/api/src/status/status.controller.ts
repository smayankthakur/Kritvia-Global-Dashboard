import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Request, Response } from "express";
import { SubscribeStatusDto } from "./dto/subscribe-status.dto";
import { StatusService } from "./status.service";

@Controller("status")
export class StatusController {
  constructor(private readonly statusService: StatusService) {}

  @Get("resolve-domain")
  async resolveDomain(@Query("host") host: string | undefined) {
    return this.statusService.resolveDomain(host ?? "");
  }

  @Post("o/:orgSlug/subscribe")
  @Throttle({ default: { limit: 3, ttl: 3600000 } })
  async subscribeByOrgSlug(
    @Req() req: Request,
    @Param("orgSlug") orgSlug: string,
    @Query("token") token: string | undefined,
    @Body() dto: SubscribeStatusDto
  ) {
    return this.statusService.subscribeByOrgSlug(orgSlug, dto, this.extractClientIp(req), token);
  }

  @Get("o/:orgSlug/confirm")
  async confirmByOrgSlug(
    @Param("orgSlug") orgSlug: string,
    @Query("token") token: string | undefined,
    @Res() res: Response
  ) {
    const confirmed = await this.statusService.confirmByOrgSlug(orgSlug, token ?? "");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(
      confirmed
        ? "<html><body><h1>Subscription confirmed</h1><p>You will now receive status updates.</p></body></html>"
        : "<html><body><h1>Invalid confirmation token</h1><p>The link is invalid or expired.</p></body></html>"
    );
  }

  @Get("o/:orgSlug/unsubscribe")
  async unsubscribeByOrgSlug(
    @Param("orgSlug") orgSlug: string,
    @Query("token") token: string | undefined,
    @Res() res: Response
  ) {
    const unsubscribed = await this.statusService.unsubscribeByOrgSlug(orgSlug, token ?? "");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(
      unsubscribed
        ? "<html><body><h1>Unsubscribed</h1><p>You will no longer receive status updates.</p></body></html>"
        : "<html><body><h1>Invalid unsubscribe token</h1><p>The link is invalid or already used.</p></body></html>"
    );
  }

  @Get("o/:orgSlug")
  async getStatusByOrgSlug(
    @Req() req: Request & { cookies?: Record<string, string | undefined> },
    @Param("orgSlug") orgSlug: string,
    @Query("token") token: string | undefined
  ) {
    return this.statusService.getPublicStatusByOrgSlug(
      orgSlug,
      token,
      req.cookies?.kritviya_status_session
    );
  }

  @Get("o/:orgSlug/incidents")
  async listIncidentsByOrgSlug(
    @Req() req: Request & { cookies?: Record<string, string | undefined> },
    @Param("orgSlug") orgSlug: string,
    @Query("token") token: string | undefined
  ) {
    return this.statusService.listPublicIncidentsByOrgSlug(
      orgSlug,
      token,
      req.cookies?.kritviya_status_session
    );
  }

  @Get("o/:orgSlug/incidents/:slug")
  async getIncidentByOrgSlug(
    @Req() req: Request & { cookies?: Record<string, string | undefined> },
    @Param("orgSlug") orgSlug: string,
    @Param("slug") slug: string,
    @Query("token") token: string | undefined
  ) {
    const incident = await this.statusService.getPublicIncidentByOrgSlugAndSlug(
      orgSlug,
      slug,
      token,
      req.cookies?.kritviya_status_session
    );
    if (!incident) {
      throw new NotFoundException("Public incident not found");
    }
    return incident;
  }

  @Post("subscribe")
  @Throttle({ default: { limit: 3, ttl: 3600000 } })
  async subscribe(@Req() req: Request, @Body() dto: SubscribeStatusDto) {
    return this.statusService.subscribeLegacy(dto, this.extractClientIp(req));
  }

  @Get("confirm")
  async confirm(@Query("token") token: string | undefined, @Res() res: Response) {
    const confirmed = await this.statusService.confirmLegacy(token ?? "");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(
      confirmed
        ? "<html><body><h1>Subscription confirmed</h1><p>You will now receive status updates.</p></body></html>"
        : "<html><body><h1>Invalid confirmation token</h1><p>The link is invalid or expired.</p></body></html>"
    );
  }

  @Get("unsubscribe")
  async unsubscribe(@Query("token") token: string | undefined, @Res() res: Response) {
    const unsubscribed = await this.statusService.unsubscribeLegacy(token ?? "");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(
      unsubscribed
        ? "<html><body><h1>Unsubscribed</h1><p>You will no longer receive status updates.</p></body></html>"
        : "<html><body><h1>Invalid unsubscribe token</h1><p>The link is invalid or already used.</p></body></html>"
    );
  }

  @Get()
  async getStatus() {
    return this.statusService.getLegacyPublicStatus();
  }

  @Get("incidents")
  async listIncidents() {
    return this.statusService.listLegacyPublicIncidents();
  }

  @Get("incidents/:slug")
  async getIncident(@Param("slug") slug: string) {
    const incident = await this.statusService.getLegacyPublicIncidentBySlug(slug);
    if (!incident) {
      throw new NotFoundException("Public incident not found");
    }
    return incident;
  }

  private extractClientIp(req: Request): string {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim().length > 0) {
      return forwarded.split(",")[0]?.trim() ?? "unknown";
    }
    if (Array.isArray(forwarded) && forwarded.length > 0) {
      return forwarded[0]?.split(",")[0]?.trim() ?? "unknown";
    }
    return req.ip || req.socket.remoteAddress || "unknown";
  }
}
