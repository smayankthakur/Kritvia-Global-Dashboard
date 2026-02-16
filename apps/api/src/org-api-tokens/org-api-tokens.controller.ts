import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { Role } from "@prisma/client";
import { AuthUserContext } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { CreateApiTokenDto } from "./dto/create-api-token.dto";
import { OrgApiTokensService } from "./org-api-tokens.service";

@Controller("org/api-tokens")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.CEO, Role.ADMIN)
export class OrgApiTokensController {
  constructor(private readonly orgApiTokensService: OrgApiTokensService) {}

  @Post()
  async create(@Req() req: { user: AuthUserContext }, @Body() dto: CreateApiTokenDto) {
    return this.orgApiTokensService.create(req.user, dto);
  }

  @Get()
  async list(@Req() req: { user: AuthUserContext }) {
    return this.orgApiTokensService.list(req.user);
  }

  @Delete(":id")
  async revoke(@Req() req: { user: AuthUserContext }, @Param("id") tokenId: string) {
    return this.orgApiTokensService.revoke(req.user, tokenId);
  }
}
