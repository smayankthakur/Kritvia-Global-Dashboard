import { Controller, Get, Param, Query, Res } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { OAuthService } from "./oauth.service";

@Controller("oauth")
export class OAuthController {
  constructor(private readonly oauthService: OAuthService) {}

  @Get("callback/:provider")
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async callback(
    @Param("provider") provider: string,
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Res() res: { redirect: (url: string) => void }
  ): Promise<void> {
    try {
      const redirectUrl = await this.oauthService.completeCallback(provider, code ?? "", state ?? "");
      res.redirect(redirectUrl);
    } catch {
      res.redirect(this.oauthService.getFailureRedirectUrl(state));
    }
  }
}
