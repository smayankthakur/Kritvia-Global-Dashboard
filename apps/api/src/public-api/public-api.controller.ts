import { Controller, Get, Query, Req, UseGuards, UseInterceptors } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RequireTokenScope } from "../auth/token-scope.decorator";
import { TokenScopeGuard } from "../auth/token-scope.guard";
import { getActiveOrgId } from "../common/auth-org";
import { buildPublicApiOpenApiDocument } from "./public-api-openapi";
import { PublicListQueryDto } from "./dto/public-list-query.dto";
import { PublicApiVersionInterceptor } from "./public-api-version.interceptor";
import { PublicApiService } from "./public-api.service";
import { ServiceAccountOnlyGuard } from "./service-account-only.guard";

@Controller("api/v1")
@UseInterceptors(PublicApiVersionInterceptor)
@UseGuards(JwtAuthGuard, ServiceAccountOnlyGuard, TokenScopeGuard)
export class PublicApiController {
  constructor(private readonly publicApiService: PublicApiService) {}

  @Get("openapi.json")
  @RequireTokenScope("read:docs")
  async getOpenApiJson() {
    return buildPublicApiOpenApiDocument(process.env.API_BASE_URL);
  }

  @Get("users")
  @RequireTokenScope("read:users")
  async listUsers(@Req() req: { user: { activeOrgId?: string; orgId?: string } }, @Query() query: PublicListQueryDto) {
    const orgId = getActiveOrgId(req);
    return this.publicApiService.listUsers(orgId, query);
  }

  @Get("deals")
  @RequireTokenScope("read:deals")
  async listDeals(@Req() req: { user: { activeOrgId?: string; orgId?: string } }, @Query() query: PublicListQueryDto) {
    const orgId = getActiveOrgId(req);
    return this.publicApiService.listDeals(orgId, query);
  }

  @Get("invoices")
  @RequireTokenScope("read:invoices")
  async listInvoices(@Req() req: { user: { activeOrgId?: string; orgId?: string } }, @Query() query: PublicListQueryDto) {
    const orgId = getActiveOrgId(req);
    return this.publicApiService.listInvoices(orgId, query);
  }

  @Get("work-items")
  @RequireTokenScope("read:work-items")
  async listWorkItems(@Req() req: { user: { activeOrgId?: string; orgId?: string } }, @Query() query: PublicListQueryDto) {
    const orgId = getActiveOrgId(req);
    return this.publicApiService.listWorkItems(orgId, query);
  }

  @Get("insights")
  @RequireTokenScope("read:insights")
  async listInsights(@Req() req: { user: { activeOrgId?: string; orgId?: string } }, @Query() query: PublicListQueryDto) {
    const orgId = getActiveOrgId(req);
    return this.publicApiService.listInsights(orgId, query);
  }

  @Get("actions")
  @RequireTokenScope("read:actions")
  async listActions(@Req() req: { user: { activeOrgId?: string; orgId?: string } }, @Query() query: PublicListQueryDto) {
    const orgId = getActiveOrgId(req);
    return this.publicApiService.listActions(orgId, query);
  }
}
