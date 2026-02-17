import { Body, Controller, Get, NotFoundException, Param, Post, Query, Req, Res } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Request, Response } from "express";
import { SubscribeStatusDto } from "./dto/subscribe-status.dto";
import { StatusService } from "./status.service";

@Controller("status")
export class StatusController {
  constructor(private readonly statusService: StatusService) {}

  @Post("subscribe")
  @Throttle({ default: { limit: 3, ttl: 3600000 } })
  async subscribe(@Req() req: Request, @Body() dto: SubscribeStatusDto) {
    return this.statusService.subscribe(dto, this.extractClientIp(req));
  }

  @Get("confirm")
  async confirm(@Query("token") token: string | undefined, @Res() res: Response) {
    const confirmed = await this.statusService.confirm(token ?? "");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(
      confirmed
        ? "<html><body><h1>Subscription confirmed</h1><p>You will now receive status updates.</p></body></html>"
        : "<html><body><h1>Invalid confirmation token</h1><p>The link is invalid or expired.</p></body></html>"
    );
  }

  @Get("unsubscribe")
  async unsubscribe(@Query("token") token: string | undefined, @Res() res: Response) {
    const unsubscribed = await this.statusService.unsubscribe(token ?? "");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(
      unsubscribed
        ? "<html><body><h1>Unsubscribed</h1><p>You will no longer receive status updates.</p></body></html>"
        : "<html><body><h1>Invalid unsubscribe token</h1><p>The link is invalid or already used.</p></body></html>"
    );
  }

  @Get()
  async getStatus() {
    return this.statusService.getPublicStatus();
  }

  @Get("incidents")
  async listIncidents() {
    return this.statusService.listPublicIncidents();
  }

  @Get("incidents/:slug")
  async getIncident(@Param("slug") slug: string) {
    const incident = await this.statusService.getPublicIncidentBySlug(slug);
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
