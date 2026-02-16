import {
  Body,
  Controller,
  Delete,
  Get,
  ParseUUIDPipe,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards
} from "@nestjs/common";
import { Role } from "@prisma/client";
import { AuthUserContext } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { PaginationQueryDto } from "../common/dto/pagination-query.dto";
import { assertFeatureEnabled } from "../common/feature-flags";
import { OrgAppsService } from "./org-apps.service";
import { OrgAppTestTriggerDto } from "./dto/org-app-test-trigger.dto";
import { UpdateOrgAppConfigDto } from "./dto/update-org-app-config.dto";

@Controller("org/apps")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.CEO, Role.ADMIN)
export class OrgAppsController {
  constructor(private readonly orgAppsService: OrgAppsService) {}

  @Get()
  async list(@Req() req: { user: AuthUserContext }) {
    assertFeatureEnabled("FEATURE_MARKETPLACE_ENABLED");
    return this.orgAppsService.list(req.user);
  }

  @Post(":key/install")
  async install(@Req() req: { user: AuthUserContext }, @Param("key") key: string) {
    assertFeatureEnabled("FEATURE_MARKETPLACE_ENABLED");
    return this.orgAppsService.install(req.user, key);
  }

  @Get(":key/oauth/start")
  async startOAuth(
    @Req() req: { user: AuthUserContext },
    @Param("key") key: string,
    @Query("mode") mode: string | undefined,
    @Res({ passthrough: true }) res: { redirect: (url: string) => void }
  ): Promise<{ authUrl: string } | void> {
    assertFeatureEnabled("FEATURE_MARKETPLACE_ENABLED");
    const authUrl = await this.orgAppsService.getOAuthStartUrl(req.user, key);
    if (mode === "url") {
      return { authUrl };
    }
    res.redirect(authUrl);
  }

  @Patch(":key/config")
  async updateConfig(
    @Req() req: { user: AuthUserContext },
    @Param("key") key: string,
    @Body() dto: UpdateOrgAppConfigDto
  ) {
    assertFeatureEnabled("FEATURE_MARKETPLACE_ENABLED");
    return this.orgAppsService.updateConfig(req.user, key, dto);
  }

  @Post(":key/rotate-secret")
  async rotateSecret(@Req() req: { user: AuthUserContext }, @Param("key") key: string) {
    assertFeatureEnabled("FEATURE_MARKETPLACE_ENABLED");
    return this.orgAppsService.rotateSecret(req.user, key);
  }

  @Post(":key/disable")
  async disable(@Req() req: { user: AuthUserContext }, @Param("key") key: string) {
    assertFeatureEnabled("FEATURE_MARKETPLACE_ENABLED");
    return this.orgAppsService.disable(req.user, key);
  }

  @Post(":key/enable")
  async enable(@Req() req: { user: AuthUserContext }, @Param("key") key: string) {
    assertFeatureEnabled("FEATURE_MARKETPLACE_ENABLED");
    return this.orgAppsService.enable(req.user, key);
  }

  @Delete(":key/uninstall")
  async uninstall(@Req() req: { user: AuthUserContext }, @Param("key") key: string) {
    assertFeatureEnabled("FEATURE_MARKETPLACE_ENABLED");
    return this.orgAppsService.uninstall(req.user, key);
  }

  @Post(":key/oauth/disconnect")
  async disconnectOAuth(@Req() req: { user: AuthUserContext }, @Param("key") key: string) {
    assertFeatureEnabled("FEATURE_MARKETPLACE_ENABLED");
    return this.orgAppsService.disconnectOAuth(req.user, key);
  }

  @Post(":key/test-trigger")
  async testTrigger(
    @Req() req: { user: AuthUserContext },
    @Param("key") key: string,
    @Body() dto: OrgAppTestTriggerDto
  ) {
    assertFeatureEnabled("FEATURE_MARKETPLACE_ENABLED");
    return this.orgAppsService.sendTestTrigger(req.user, key, dto.eventName);
  }

  @Get(":key/deliveries")
  async listDeliveries(
    @Req() req: { user: AuthUserContext },
    @Param("key") key: string,
    @Query() query: PaginationQueryDto
  ) {
    assertFeatureEnabled("FEATURE_MARKETPLACE_ENABLED");
    return this.orgAppsService.listDeliveries(req.user, key, query);
  }

  @Post(":key/deliveries/:deliveryId/replay")
  async replayDelivery(
    @Req() req: { user: AuthUserContext },
    @Param("key") key: string,
    @Param("deliveryId", new ParseUUIDPipe()) deliveryId: string
  ) {
    assertFeatureEnabled("FEATURE_MARKETPLACE_ENABLED");
    return this.orgAppsService.replayDelivery(req.user, key, deliveryId);
  }

  @Get(":key/command-logs")
  async listCommandLogs(
    @Req() req: { user: AuthUserContext },
    @Param("key") key: string,
    @Query() query: PaginationQueryDto
  ) {
    assertFeatureEnabled("FEATURE_MARKETPLACE_ENABLED");
    return this.orgAppsService.listCommandLogs(req.user, key, query);
  }
}
