import { Body, Controller, Post, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { AuthUserContext } from "../auth/auth.types";
import { CreateOrgDto } from "./dto/create-org.dto";
import { OrgsService } from "./orgs.service";

@Controller("orgs")
export class OrgsController {
  constructor(private readonly orgsService: OrgsService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  async create(@Req() req: { user: AuthUserContext }, @Body() dto: CreateOrgDto) {
    return this.orgsService.create(req.user, dto);
  }
}

