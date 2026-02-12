import { Body, Controller, Get, Post, Req, Res, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Request, Response } from "express";
import { AuthService } from "./auth.service";
import { LoginDto } from "./dto/login.dto";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { AuthUserContext } from "./auth.types";

const REFRESH_COOKIE_NAME = "kritviya_refresh_token";

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("login")
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) response: Response
  ): Promise<{ accessToken: string }> {
    const tokens = await this.authService.login(dto);
    this.setRefreshCookie(response, tokens.refreshToken);
    return { accessToken: tokens.accessToken };
  }

  @Post("refresh")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ): Promise<{ accessToken: string }> {
    const refreshToken = request.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
    const tokens = await this.authService.refresh(refreshToken ?? "");
    this.setRefreshCookie(response, tokens.refreshToken);
    return { accessToken: tokens.accessToken };
  }

  @Post("logout")
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ): Promise<{ success: true }> {
    const refreshToken = request.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
    await this.authService.logout(refreshToken);
    this.clearRefreshCookie(response);
    return { success: true };
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  async me(@Req() req: { user: AuthUserContext }): Promise<{
    id: string;
    name: string;
    email: string;
    role: AuthUserContext["role"];
    orgId: string;
  }> {
    return this.authService.getMe(req.user);
  }

  private setRefreshCookie(response: Response, refreshToken: string): void {
    const cookieDomain = process.env.COOKIE_DOMAIN;
    response.cookie(REFRESH_COOKIE_NAME, refreshToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.COOKIE_SECURE === "true",
      path: "/auth",
      domain: cookieDomain || undefined,
      maxAge: this.getRefreshCookieMaxAgeMs()
    });
  }

  private clearRefreshCookie(response: Response): void {
    const cookieDomain = process.env.COOKIE_DOMAIN;
    response.clearCookie(REFRESH_COOKIE_NAME, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.COOKIE_SECURE === "true",
      path: "/auth",
      domain: cookieDomain || undefined
    });
  }

  private getRefreshCookieMaxAgeMs(): number {
    const duration = process.env.REFRESH_TOKEN_TTL;
    if (duration) {
      const parsed = this.parseDurationMs(duration);
      if (parsed) {
        return parsed;
      }
    }
    const ttlDays = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 7);
    if (!Number.isFinite(ttlDays) || ttlDays <= 0) {
      return 7 * 24 * 60 * 60 * 1000;
    }
    return ttlDays * 24 * 60 * 60 * 1000;
  }

  private parseDurationMs(raw: string): number | null {
    const value = raw.trim().toLowerCase();
    const match = value.match(/^(\d+)(ms|s|m|h|d)$/);
    if (!match) {
      return null;
    }
    const amount = Number(match[1]);
    const unit = match[2];
    const unitMs: Record<string, number> = {
      ms: 1,
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000
    };
    return amount * unitMs[unit];
  }
}
