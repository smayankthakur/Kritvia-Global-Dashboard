import { Controller, Get, Param, Query, Req, UseGuards } from "@nestjs/common";
import { AuthUserContext } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ListMarketplaceAppsDto } from "./dto/list-marketplace-apps.dto";
import { MarketplaceService } from "./marketplace.service";

@Controller("marketplace/apps")
@UseGuards(JwtAuthGuard)
export class MarketplaceController {
  constructor(private readonly marketplaceService: MarketplaceService) {}

  @Get()
  async list(@Query() query: ListMarketplaceAppsDto) {
    return this.marketplaceService.listPublished(query);
  }

  @Get(":key")
  async getByKey(@Req() req: { user: AuthUserContext }, @Param("key") key: string) {
    return this.marketplaceService.getByKey(key, req.user);
  }
}
