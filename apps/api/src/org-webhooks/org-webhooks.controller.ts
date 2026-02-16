import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UseGuards
} from "@nestjs/common";
import { Role } from "@prisma/client";
import { AuthUserContext } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { CreateWebhookEndpointDto } from "./dto/create-webhook-endpoint.dto";
import { OrgWebhooksService } from "./org-webhooks.service";

@Controller("org/webhooks")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.CEO, Role.ADMIN)
export class OrgWebhooksController {
  constructor(private readonly orgWebhooksService: OrgWebhooksService) {}

  @Post()
  async create(@Req() req: { user: AuthUserContext }, @Body() dto: CreateWebhookEndpointDto) {
    return this.orgWebhooksService.create(req.user, dto);
  }

  @Get()
  async list(@Req() req: { user: AuthUserContext }) {
    return this.orgWebhooksService.list(req.user);
  }

  @Delete(":id")
  async remove(@Req() req: { user: AuthUserContext }, @Param("id") id: string) {
    return this.orgWebhooksService.remove(req.user, id);
  }
}
