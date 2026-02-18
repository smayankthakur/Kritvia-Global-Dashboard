import { Body, Controller, Get, Post, Query, Req, Res } from "@nestjs/common";
import { Request, Response } from "express";
import { RequestStatusAuthLinkDto } from "./dto/request-status-auth-link.dto";
import { StatusService } from "./status.service";

@Controller("status-auth")
export class StatusAuthController {
  constructor(private readonly statusService: StatusService) {}

  @Post("request-link")
  async requestLink(@Req() req: Request, @Body() dto: RequestStatusAuthLinkDto) {
    return this.statusService.requestMagicLink(dto.orgSlug, dto.email, this.extractClientIp(req));
  }

  @Get("verify")
  async verify(
    @Query("orgSlug") orgSlug: string | undefined,
    @Query("email") email: string | undefined,
    @Query("token") token: string | undefined,
    @Res({ passthrough: true }) res: Response
  ) {
    const result = await this.statusService.verifyMagicLink(orgSlug ?? "", email ?? "", token ?? "");
    res.cookie(result.cookie.name, result.cookie.value, result.cookie.options);
    return { ok: true };
  }

  @Post("logout")
  async logout(@Res({ passthrough: true }) res: Response) {
    const cookie = this.statusService.getClearedStatusSessionCookie();
    res.cookie(cookie.name, cookie.value, cookie.options);
    return { ok: true };
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
