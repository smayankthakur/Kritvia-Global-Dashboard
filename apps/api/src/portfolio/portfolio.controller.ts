import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AuthUserContext } from "../auth/auth.types";
import { PortfolioService } from "./portfolio.service";
import { CreatePortfolioDto } from "./dto/create-portfolio.dto";
import { AttachPortfolioOrgDto } from "./dto/attach-portfolio-org.dto";
import { ListPortfolioDto } from "./dto/list-portfolio.dto";

@Controller("portfolio")
@UseGuards(JwtAuthGuard)
export class PortfolioController {
  constructor(private readonly portfolioService: PortfolioService) {}

  @Post()
  async create(@Req() req: { user: AuthUserContext }, @Body() dto: CreatePortfolioDto) {
    return this.portfolioService.create(req.user, dto);
  }

  @Get()
  async list(@Req() req: { user: AuthUserContext }, @Query() query: ListPortfolioDto) {
    return this.portfolioService.list(req.user, query);
  }

  @Post(":id/orgs")
  async attachOrg(
    @Req() req: { user: AuthUserContext },
    @Param("id") id: string,
    @Body() dto: AttachPortfolioOrgDto
  ) {
    return this.portfolioService.attachOrg(req.user, id, dto);
  }

  @Delete(":id/orgs/:orgId")
  async detachOrg(
    @Req() req: { user: AuthUserContext },
    @Param("id") id: string,
    @Param("orgId") orgId: string
  ) {
    return this.portfolioService.detachOrg(req.user, id, orgId);
  }

  @Get(":id/summary")
  async summary(@Req() req: { user: AuthUserContext }, @Param("id") id: string) {
    return this.portfolioService.getSummary(req.user, id);
  }
}
