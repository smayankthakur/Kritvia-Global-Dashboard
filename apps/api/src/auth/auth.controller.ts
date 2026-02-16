import { Body, Controller, Get, Post, Req, Res, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { AuthService } from "./auth.service";
import { LoginDto } from "./dto/login.dto";
import { SwitchOrgDto } from "./dto/switch-org.dto";
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
    @Res({ passthrough: true }) response: any
  ): Promise<{ accessToken: string }> {
    const tokens = await this.authService.login(dto);
    this.setRefreshCookie(response, tokens.refreshToken);
    return { accessToken: tokens.accessToken };
  }

  @Post("refresh")
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async refresh(
    @Req() request: any,
    @Res({ passthrough: true }) response: any
  ): Promise<{ accessToken: string }> {
    const refreshToken = request.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
    const tokens = await this.authService.refresh(refreshToken ?? "");
    this.setRefreshCookie(response, tokens.refreshToken);
    return { accessToken: tokens.accessToken };
  }

  @Post("logout")
  async logout(
    @Req() request: any,
    @Res({ passthrough: true }) response: any
  ): Promise<{ success: true }> {
    const refreshToken = request.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
    await this.authService.logout(refreshToken);
    this.clearRefreshCookie(response);
    return { success: true };
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  async me(@Req() req: { user: AuthUserContext }) {
    return this.authService.getMe(req.user);
  }

  @Post("switch-org")
  @UseGuards(JwtAuthGuard)
  async switchOrg(
    @Req() req: { user: AuthUserContext },
    @Body() dto: SwitchOrgDto
  ): Promise<{ accessToken: string }> {
    return this.authService.switchOrg(req.user, dto.orgId);
  }

  private setRefreshCookie(response: any, refreshToken: string): void {
    response.cookie(REFRESH_COOKIE_NAME, refreshToken, {
      ...this.baseCookieOptions(),
      maxAge: this.getRefreshCookieMaxAgeMs()
    });
  }

  private clearRefreshCookie(response: any): void {
    response.clearCookie(REFRESH_COOKIE_NAME, {
      ...this.baseCookieOptions()
    });
  }

  private baseCookieOptions(): {
    httpOnly: boolean;
    sameSite: "none" | "strict" | "lax";
    secure: boolean;
    path: string;
    domain?: string;
  } {
    const cookieDomain = process.env.COOKIE_DOMAIN;
    const secure = process.env.COOKIE_SECURE === "true";
    const sameSiteRaw = (process.env.COOKIE_SAMESITE ?? "").toLowerCase();
    const sameSite: "none" | "strict" | "lax" =
      sameSiteRaw === "none" || sameSiteRaw === "strict" || sameSiteRaw === "lax"
        ? sameSiteRaw
        : process.env.NODE_ENV === "production"
          ? "none"
          : "lax";

    return {
      httpOnly: true,
      sameSite,
      secure: sameSite === "none" ? true : secure,
      path: "/auth",
      domain: cookieDomain || undefined
    };
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
